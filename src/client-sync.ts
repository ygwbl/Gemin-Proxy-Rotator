import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";

const CREDENTIAL_TARGET = "gemini:antigravity";
const CREDENTIAL_USER = "antigravity";

export interface DeviceProfile {
  machineId: string;
  macMachineId: string;
  devDeviceId: string;
  sqmId: string;
}

export function getStorageJsonPath(): string | null {
  const appData = process.env.APPDATA || "";
  if (!appData) return null;

  const candidatePaths = [
    path.join(appData, "Antigravity IDE", "User", "globalStorage", "storage.json"),
    path.join(appData, "Antigravity", "User", "globalStorage", "storage.json"),
  ];

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function generateDeviceProfile(): DeviceProfile {
  const machineId = crypto.randomBytes(32).toString("hex");
  const macMachineId = crypto.randomUUID();
  const devDeviceId = crypto.randomUUID();
  const sqmId = `{${crypto.randomUUID().toUpperCase()}}`;

  return {
    machineId,
    macMachineId,
    devDeviceId,
    sqmId,
  };
}

function getDeviceProfilesFilePath(): string {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const dir = path.join(home, ".tuxevil-rotator");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "device-profiles.json");
}

export function getAccountDeviceProfile(email: string): DeviceProfile {
  const filePath = getDeviceProfilesFilePath();
  let profiles: Record<string, DeviceProfile> = {};
  try {
    if (fs.existsSync(filePath)) {
      profiles = JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  } catch {}

  if (!profiles[email]) {
    profiles[email] = generateDeviceProfile();
    try {
      fs.writeFileSync(filePath, JSON.stringify(profiles, null, 2), "utf8");
    } catch {}
  }
  return profiles[email];
}

export function injectDeviceProfileToStorage(email: string): { ok: boolean; path?: string; error?: string } {
  const storagePath = getStorageJsonPath();
  if (!storagePath) {
    return { ok: false, error: "未找到 Antigravity 本地 storage.json 路径" };
  }

  try {
    const profile = getAccountDeviceProfile(email);
    const content = fs.readFileSync(storagePath, "utf8");
    const json = JSON.parse(content);

    json["telemetry.machineId"] = profile.machineId;
    json["telemetry.macMachineId"] = profile.macMachineId;
    json["telemetry.devDeviceId"] = profile.devDeviceId;
    json["telemetry.sqmId"] = profile.sqmId;

    if (json.telemetry && typeof json.telemetry === "object") {
      json.telemetry.machineId = profile.machineId;
      json.telemetry.macMachineId = profile.macMachineId;
      json.telemetry.devDeviceId = profile.devDeviceId;
      json.telemetry.sqmId = profile.sqmId;
    }

    fs.writeFileSync(storagePath, JSON.stringify(json, null, 4), "utf8");
    return { ok: true, path: storagePath };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function writeWindowsKeyringToken(
  accessToken: string,
  refreshToken: string,
  expiryDateStr?: string
): Promise<{ ok: boolean; error?: string }> {
  const expiry = expiryDateStr || new Date(Date.now() + 3600 * 1000).toISOString();
  const payload = JSON.stringify({
    token: {
      access_token: accessToken,
      token_type: "Bearer",
      refresh_token: refreshToken,
      expiry,
    },
    auth_method: "consumer",
  });

  const b64 = Buffer.from(payload).toString("base64");
  const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CredWriter {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public long LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredWrite([In] ref CREDENTIAL userCredential, [In] uint flags);

    public static bool Write(string target, string user, string secret) {
        byte[] b = System.Text.Encoding.UTF8.GetBytes(secret);
        IntPtr bPtr = Marshal.AllocHGlobal(b.Length);
        Marshal.Copy(b, 0, bPtr, b.Length);
        CREDENTIAL cred = new CREDENTIAL();
        cred.Flags = 0;
        cred.Type = 1;
        cred.TargetName = target;
        cred.UserName = user;
        cred.CredentialBlobSize = b.Length;
        cred.CredentialBlob = bPtr;
        cred.Persist = 2;
        bool res = CredWrite(ref cred, 0);
        Marshal.FreeHGlobal(bPtr);
        return res;
    }
}
"@
$bytes = [Convert]::FromBase64String("${b64}")
$json = [System.Text.Encoding]::UTF8.GetString($bytes)
$res = [CredWriter]::Write("${CREDENTIAL_TARGET}", "${CREDENTIAL_USER}", $json)
if ($res) { Write-Output "OK" } else { Write-Output "FAIL" }
`;

  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-Command", psScript], (err, stdout) => {
      if (err) {
        resolve({ ok: false, error: err.message });
      } else if (stdout.trim().includes("OK")) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: stdout.trim() });
      }
    });
  });
}

export async function syncAccountToAntigravityClient(
  email: string,
  accessToken: string,
  refreshToken: string,
  expiryStr?: string
): Promise<{ ok: boolean; message: string; deviceProfile?: DeviceProfile }> {
  const profile = getAccountDeviceProfile(email);
  injectDeviceProfileToStorage(email);

  const credRes = await writeWindowsKeyringToken(accessToken, refreshToken, expiryStr);
  if (!credRes.ok) {
    return {
      ok: false,
      message: `凭据管理器写入失败: ${credRes.error}`,
    };
  }

  return {
    ok: true,
    message: `已成功将 ${email} 同步至反重力客户端！已绑定独立设备指纹。`,
    deviceProfile: profile,
  };
}

let _cachedDetectedClientEmail: string | null = null;
let _lastDetectTime = 0;

export async function detectCurrentClientAccount(
  accounts: Array<{ email: string; refreshToken?: string }>
): Promise<string | null> {
  const now = Date.now();
  if (_cachedDetectedClientEmail !== null && now - _lastDetectTime < 5000) {
    return _cachedDetectedClientEmail;
  }

  const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CredReader {
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern void CredFree(IntPtr cred);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public long LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    public static string Read(string target) {
        IntPtr credPtr;
        if (CredRead(target, 1, 0, out credPtr)) {
            CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(credPtr, typeof(CREDENTIAL));
            byte[] b = new byte[cred.CredentialBlobSize];
            Marshal.Copy(cred.CredentialBlob, b, 0, cred.CredentialBlobSize);
            CredFree(credPtr);
            return System.Text.Encoding.UTF8.GetString(b);
        }
        return null;
    }
}
"@
$s = [CredReader]::Read("${CREDENTIAL_TARGET}")
if ($s) {
    [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($s))
}
`;

  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-Command", psScript], (err, stdout) => {
      _lastDetectTime = Date.now();
      if (err || !stdout.trim()) {
        resolve(_cachedDetectedClientEmail);
        return;
      }
      try {
        const rawJson = Buffer.from(stdout.trim(), "base64").toString("utf8");
        const parsed = JSON.parse(rawJson);
        const refreshToken = parsed?.token?.refresh_token;
        if (refreshToken) {
          const matched = accounts.find((a) => a.refreshToken === refreshToken);
          if (matched) {
            _cachedDetectedClientEmail = matched.email;
            resolve(matched.email);
            return;
          }
        }
      } catch {}
      resolve(_cachedDetectedClientEmail);
    });
  });
}