// The capabilities the server's container keeps: switching to the browser and session users, giving them their
// directories, reading what they write, stopping their processes, and SYS_CHROOT, which Chrome's sandbox needs.
export const CONTAINER_CAPABILITIES = ['SETUID', 'SETGID', 'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'KILL', 'SYS_CHROOT'] as const;
