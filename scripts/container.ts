// The capabilities the server's container keeps: switching to the browser and session users, giving them their
// directories, reading what they write, stopping their processes, and SYS_CHROOT, which Chrome's sandbox needs.
export const CONTAINER_CAPABILITIES = ['SETUID', 'SETGID', 'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'KILL', 'SYS_CHROOT'] as const;

/** The Linux capability number of each capability above, in the order of <linux/capability.h>. */
const CAPABILITY_BITS: Record<(typeof CONTAINER_CAPABILITIES)[number], number> = {
  CHOWN: 0,
  DAC_OVERRIDE: 1,
  FOWNER: 3,
  KILL: 5,
  SETGID: 6,
  SETUID: 7,
  SYS_CHROOT: 18,
};

/** The bits of exactly those capabilities, as a process's CapEff prints them. */
export const CONTAINER_CAPABILITY_MASK = CONTAINER_CAPABILITIES.reduce((mask, name) => mask | (1 << CAPABILITY_BITS[name]), 0);
