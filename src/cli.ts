// The browserctl command: `serve` runs the server; `admin` talks to a running server over its admin socket.

import { randomUUID } from 'node:crypto';
import { SeverityNumber, logs } from '@opentelemetry/api';
import { adminRequest } from './admin/socket.ts';
import { loadAdminConfig, loadServerConfig, type AdminConfig } from './config/config.ts';
import { ConfigError } from './config/schema.ts';
import { BrowserctlError, publicMessage } from './errors.ts';
import { BrowserctlServer } from './server/server.ts';
import { startTelemetry } from './telemetry/sdk.ts';
import { inSpan, instrument } from './telemetry/signals.ts';

const USAGE = `usage:
  browserctl serve
  browserctl admin tokens create <name>
  browserctl admin tokens list
  browserctl admin tokens revoke <name>
  browserctl admin telemetry-probe`;

export interface Output {
  out(line: string): void;
  err(line: string): void;
}

const console_: Output = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

export interface Dependencies {
  startTelemetry: typeof startTelemetry;
}

export async function main(
  argv: string[],
  environment: Record<string, string | undefined>,
  output: Output = console_,
  dependencies: Dependencies = { startTelemetry },
): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'serve' && rest.length === 0) return await serve(environment, output, dependencies);
    if (command === 'admin') return await admin(rest, environment, output, dependencies);
    output.err(USAGE);
    return 2;
  } catch (error) {
    output.err(`browserctl: ${error instanceof ConfigError ? error.message : publicMessage(error)}`);
    return 1;
  }
}

async function serve(environment: Record<string, string | undefined>, output: Output, dependencies: Dependencies): Promise<number> {
  const config = loadServerConfig(environment);
  const telemetry = dependencies.startTelemetry(config.telemetry, 'browserctl-server');
  const server = new BrowserctlServer(config);
  try {
    await server.start();
  } catch (error) {
    await server.stop().catch(() => undefined);
    await telemetry.shutdown();
    throw error;
  }
  output.out(`browserctl: listening on ${config.listenAddress}:${server.port}`);
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
  await server.stop();
  await telemetry.shutdown();
  return 0;
}

type AdminCommand = { key: string; args: Record<string, unknown>; print: (result: unknown, output: Output) => void };

function parseAdmin(argv: string[]): AdminCommand | undefined {
  const [group, action, name, ...extra] = argv;
  if (group === 'tokens' && action === 'create' && name && extra.length === 0) {
    return { key: 'tokens.create', args: { name }, print: (result, output) => output.out((result as { token: string }).token) };
  }
  if (group === 'tokens' && action === 'list' && name === undefined) {
    return {
      key: 'tokens.list',
      args: {},
      print: (result, output) => {
        for (const client of result as Array<{ name: string; createdAt: string }>) output.out(`${client.name}\t${client.createdAt}`);
      },
    };
  }
  if (group === 'tokens' && action === 'revoke' && name && extra.length === 0) {
    return { key: 'tokens.revoke', args: { name }, print: (_result, output) => output.out(`revoked ${name}`) };
  }
  return undefined;
}

async function admin(argv: string[], environment: Record<string, string | undefined>, output: Output, dependencies: Dependencies): Promise<number> {
  if (argv.length === 1 && argv[0] === 'telemetry-probe') return await probe(loadAdminConfig(environment), output, dependencies);
  const command = parseAdmin(argv);
  if (!command) {
    output.err(USAGE);
    return 2;
  }
  const config = loadAdminConfig(environment);
  const telemetry = dependencies.startTelemetry(config.telemetry, 'browserctl-admin');
  try {
    const result = await inSpan('browserctl.admin.command', { 'browserctl.admin.command': command.key }, () =>
      adminRequest(config.stateDirectory, command.key, command.args),
    );
    command.print(result, output);
    return 0;
  } catch (error) {
    output.err(`browserctl: ${publicMessage(error)}`);
    return error instanceof BrowserctlError && error.errorClass === 'invalid_request' ? 2 : 1;
  } finally {
    await telemetry.shutdown();
  }
}

/** Emit one qualification span, metric point, and log record, so a collector registration can be verified. */
async function probe(config: AdminConfig, output: Output, dependencies: Dependencies): Promise<number> {
  const telemetry = dependencies.startTelemetry(config.telemetry, 'browserctl-admin');
  const id = randomUUID();
  await inSpan('browserctl.qualification', { 'browserctl.session.id': id }, async () => {
    instrument().qualification.add(1);
    logs.getLogger('browserctl').emit({ body: 'browserctl.qualification', severityNumber: SeverityNumber.INFO, attributes: { 'browserctl.session.id': id } });
  });
  await telemetry.shutdown();
  output.out(`probe ${id}`);
  return 0;
}
