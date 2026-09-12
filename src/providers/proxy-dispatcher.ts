import { Agent, ProxyAgent } from "undici";
import type { Dispatcher } from "undici";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { AccountRuntime } from "../types.js";
import { getProviderProxyUrl } from "./credential-helpers.js";

const SUPPORTED_PROXY_PROTOCOLS = new Set([
	"http:",
	"https:",
	"socks:",
	"socks5:",
	"socks5h:",
]);

const dispatchers = new Map<string, Dispatcher>();

function normalizedProxyUrl(value: string): string {
	const url = new URL(value);
	if (!SUPPORTED_PROXY_PROTOCOLS.has(url.protocol)) {
		throw new Error("Account proxy must use http://, https://, socks5://, or socks5h://");
	}
	if (!url.hostname) {
		throw new Error("Account proxy must include a hostname");
	}
	if ((url.username === "") !== (url.password === "")) {
		throw new Error("Account proxy username and password must be provided together");
	}
	if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
		throw new Error("Account proxy must not include a path, query, or fragment");
	}
	if (url.protocol === "socks5h:") url.protocol = "socks5:";
	if (url.protocol === "socks:") url.protocol = "socks5:";
	return url.toString();
}

/** Return a safe validation message without echoing proxy credentials. */
export function getProxyConfigurationError(value: unknown): string | null {
	if (value === undefined || value === null || value === "") return null;
	if (typeof value !== "string") return "proxyUrl must be a string";
	if (value.length > 2048) return "proxyUrl exceeds the maximum length of 2048 characters";
	try {
		normalizedProxyUrl(value.trim());
		return null;
	} catch (err) {
		const message = err instanceof Error ? err.message : "invalid URL";
		return message === "Invalid URL" ? "proxyUrl is invalid" : `proxyUrl ${message.toLowerCase()}`;
	}
}

function createDispatcher(proxyUrl: string): Dispatcher {
	const normalized = normalizedProxyUrl(proxyUrl);
	const url = new URL(normalized);
	if (url.protocol === "socks5:") return createSocks5Dispatcher(url);
	return new ProxyAgent({ uri: normalized, proxyTunnel: false });
}

type SocksSocket = Socket | TLSSocket;

function createSocketReader(socket: Socket): {
	read(length: number): Promise<Buffer>;
	close(): void;
} {
	let buffered = Buffer.alloc(0);
	let failure: Error | null = null;
	let waiter: {
		length: number;
		resolve: (value: Buffer) => void;
		reject: (err: Error) => void;
	} | null = null;

	const drain = (): void => {
		if (!waiter || buffered.length < waiter.length) return;
		const current = waiter;
		waiter = null;
		const value = buffered.subarray(0, current.length);
		buffered = buffered.subarray(current.length);
		current.resolve(value);
	};
	const onData = (chunk: Buffer): void => {
		buffered = Buffer.concat([buffered, chunk]);
		drain();
	};
	const onError = (err: Error): void => {
		failure = err;
		if (waiter) {
			const current = waiter;
			waiter = null;
			current.reject(err);
		}
	};
	const onClose = (): void => onError(new Error("SOCKS5 proxy connection closed"));
	const onTimeout = (): void => onError(new Error("SOCKS5 proxy connection timed out"));
	socket.on("data", onData);
	socket.once("error", onError);
	socket.once("close", onClose);
	socket.once("timeout", onTimeout);

	return {
		read(length: number): Promise<Buffer> {
			if (failure) return Promise.reject(failure);
			if (buffered.length >= length) {
				const value = buffered.subarray(0, length);
				buffered = buffered.subarray(length);
				return Promise.resolve(value);
			}
			return new Promise((resolve, reject) => {
				waiter = { length, resolve, reject };
				drain();
			});
		},
		close(): void {
			socket.off("data", onData);
			socket.off("error", onError);
			socket.off("close", onClose);
			socket.off("timeout", onTimeout);
		},
	};
}

function encodeIpv6(host: string): Buffer {
	const [headText, tailText] = host.split("::");
	const head = headText ? headText.split(":").filter(Boolean) : [];
	const tail = tailText ? tailText.split(":").filter(Boolean) : [];
	const missing = 8 - head.length - tail.length;
	const groups = host.includes("::")
		? [...head, ...Array.from({ length: Math.max(0, missing) }, () => "0"), ...tail]
		: [...head, ...tail];
	const encoded = Buffer.alloc(16);
	for (let index = 0; index < 8; index++) {
		encoded.writeUInt16BE(parseInt(groups[index] || "0", 16) || 0, index * 2);
	}
	return encoded;
}

async function openSocks5Connection(
	proxy: URL,
	target: { hostname: string; port: string; protocol: string; servername?: string },
): Promise<SocksSocket> {
	const socket = netConnect({
		host: proxy.hostname,
		port: Number(proxy.port || 1080),
	});
	socket.setTimeout(10_000);
	const reader = createSocketReader(socket);
	try {
		await new Promise<void>((resolve, reject) => {
			const onConnect = (): void => {
				socket.off("error", onError);
				resolve();
			};
			const onError = (err: Error): void => {
				socket.off("connect", onConnect);
				reject(err);
			};
			socket.once("connect", onConnect);
			socket.once("error", onError);
		});

		const username = proxy.username ? decodeURIComponent(proxy.username) : "";
		const password = proxy.password ? decodeURIComponent(proxy.password) : "";
		const hasAuth = username.length > 0 || password.length > 0;
		const methods = hasAuth ? [0x02, 0x00] : [0x00];
		socket.write(Buffer.from([0x05, methods.length, ...methods]));
		const methodReply = await reader.read(2);
		if (methodReply[0] !== 0x05 || methodReply[1] === 0xff) {
			throw new Error("SOCKS5 proxy rejected authentication methods");
		}
		if (methodReply[1] === 0x02) {
			const user = Buffer.from(username);
			const pass = Buffer.from(password);
			if (user.length > 255 || pass.length > 255) {
				throw new Error("SOCKS5 proxy credentials are too long");
			}
			socket.write(Buffer.concat([
				Buffer.from([0x01, user.length]),
				user,
				Buffer.from([pass.length]),
				pass,
			]));
			const authReply = await reader.read(2);
			if (authReply[0] !== 0x01 || authReply[1] !== 0x00) {
				throw new Error("SOCKS5 proxy authentication failed");
			}
		} else if (methodReply[1] !== 0x00) {
			throw new Error("SOCKS5 proxy selected an unsupported authentication method");
		}

		const targetHost = target.hostname;
		const targetIpVersion = isIP(targetHost);
		const targetAddress = targetIpVersion === 4
			? Buffer.from([0x01, ...targetHost.split(".").map((part) => Number(part))])
			: targetIpVersion === 6
				? Buffer.from([0x04, ...encodeIpv6(targetHost)])
				: Buffer.from([0x03, Buffer.byteLength(targetHost), ...Buffer.from(targetHost)]);
		const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
		if (!Number.isInteger(port) || port < 1 || port > 65_535) {
			throw new Error("SOCKS5 target port is invalid");
		}
		const connectRequest = Buffer.alloc(3 + targetAddress.length + 2);
		Buffer.from([0x05, 0x01, 0x00]).copy(connectRequest, 0);
		targetAddress.copy(connectRequest, 3);
		connectRequest.writeUInt16BE(port, connectRequest.length - 2);
		socket.write(connectRequest);
		const replyHead = await reader.read(4);
		if (replyHead[0] !== 0x05 || replyHead[1] !== 0x00) {
			throw new Error(`SOCKS5 proxy connection failed (code ${replyHead[1] ?? "unknown"})`);
		}
		const replyAddressLength = replyHead[3] === 0x01
			? 4
			: replyHead[3] === 0x04
				? 16
				: 1 + (await reader.read(1))[0];
		await reader.read(replyAddressLength + 2);

		if (target.protocol !== "https:") return socket;
		const tlsSocket = tlsConnect({
			socket,
			servername: target.servername || target.hostname,
		});
		await new Promise<void>((resolve, reject) => {
			tlsSocket.once("secureConnect", resolve);
			tlsSocket.once("error", reject);
		});
		return tlsSocket;
	} catch (err) {
		socket.destroy();
		throw err;
	} finally {
		reader.close();
		socket.setTimeout(0);
	}
}

function createSocks5Dispatcher(proxy: URL): Dispatcher {
	return new Agent({
		connect: (target, callback) => {
			void openSocks5Connection(proxy, target)
				.then((socket) => callback(null, socket))
				.catch((err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), null));
		},
	});
}

/**
 * Return the reusable dispatcher for an account/provider pair. The cache key
 * includes the complete normalized URL, including credentials, but that value
 * is never logged or returned to callers.
 */
export function getAccountProxyDispatcher(
	account: AccountRuntime,
	providerId: string,
): Dispatcher | undefined {
	const configured = getProviderProxyUrl(account.config, providerId)?.trim();
	if (!configured) return undefined;
	const key = normalizedProxyUrl(configured);
	const existing = dispatchers.get(key);
	if (existing) return existing;
	const dispatcher = createDispatcher(key);
	dispatchers.set(key, dispatcher);
	return dispatcher;
}

/** Close cached agents during controlled process shutdown or test teardown. */
export async function closeProxyDispatchers(): Promise<void> {
	const pending = [...dispatchers.values()].map((dispatcher) => dispatcher.close());
	dispatchers.clear();
	await Promise.allSettled(pending);
}
