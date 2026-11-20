import { run } from './downloader.mjs';

// VeraCrypt 1.26 Apidrvr.h defines a packed MOUNT_LIST_STRUCT containing
// a drive bitmask followed by 26 UTF-16 paths of 260 characters each.
const mountListScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class VAMPVeraCryptMounts {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security,
        uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool DeviceIoControl(SafeFileHandle handle, uint code, byte[] input, int inputSize,
        [Out] byte[] output, int outputSize, out int returned, IntPtr overlapped);
    public static string[] Read() {
        using (var driver = CreateFile(@"\\.\VeraCrypt", 0, 3, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
            if (driver.IsInvalid) throw new InvalidOperationException("VeraCrypt driver unavailable.");
            const int slots = 26, pathBytes = 260 * 2;
            const int listSize = 4 + slots * (pathBytes + 33 * 2 + 32 * 2 + 8 + 4 + 4 + 4);
            var version = new byte[4];
            int length;
            if (!DeviceIoControl(driver, 0x222004, null, 0, version, version.Length, out length, IntPtr.Zero)
                || length != version.Length || BitConverter.ToUInt32(version, 0) != 0x0126)
                throw new InvalidOperationException("Unsupported VeraCrypt driver version.");
            var list = new byte[listSize];
            if (!DeviceIoControl(driver, 0x222018, new byte[listSize], listSize, list, listSize, out length, IntPtr.Zero)
                || length != listSize) throw new InvalidOperationException("VeraCrypt mount list unavailable.");
            var drives = BitConverter.ToUInt32(list, 0);
            if (drives >= (1u << slots)) throw new InvalidOperationException("Invalid VeraCrypt drive mapping.");
            var paths = new string[slots];
            for (int i = 0; i < slots; i++) {
                if ((drives & (1u << i)) == 0) continue;
                var value = Encoding.Unicode.GetString(list, 4 + i * pathBytes, pathBytes);
                int end = value.IndexOf('\0');
                if (end <= 0) throw new InvalidOperationException("Invalid VeraCrypt backing path.");
                paths[i] = value.Substring(0, end);
            }
            return paths;
        }
    }
}
'@
ConvertTo-Json -InputObject ([VAMPVeraCryptMounts]::Read()) -Compress
`;

export async function readWindowsVeraCryptMounts(env = process.env) {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', mountListScript],
    { timeout: 30000, env });
  const slots = JSON.parse(stdout);
  if (!Array.isArray(slots) || slots.length !== 26) throw new Error('Invalid VeraCrypt mount list.');
  return slots.flatMap((nativePath, index) => {
    if (nativePath === null) return [];
    const letter = String.fromCharCode(65 + index);
    const localPath = /^\\\?\?\\([a-z]:\\[^\x00-\x1f]+)$/i.exec(nativePath)?.[1];
    return [{ mount_point: letter + ':', device: '\\Device\\VeraCryptVolume' + letter,
      volume: localPath ?? null, slot: index + 1 }];
  });
}
