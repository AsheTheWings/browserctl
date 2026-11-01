// A run-owned fake model server for the OpenAI Responses API. It drives an e2e agent step asking to press a named
// button: it taps the button the screen lists, then concludes the step as passed.

import { createServer, type Server } from 'node:http';

export interface FakeModel {
  url: string;
  /** Every request's Authorization header, in order. */
  authorizations: string[];
  close(): Promise<void>;
}

interface ResponsesRequest {
  model: string;
  input: unknown[];
}

function reply(request: ResponsesRequest, sequence: number): unknown {
  const transcript = JSON.stringify(request.input);
  const acted = request.input.some((item) => (item as { type?: string }).type === 'function_call_output');
  const button = /press the \\"([^\\]+)\\" button/.exec(transcript)?.[1];
  const target = button ? new RegExp(`#(n\\d+) button \\\\"${button}\\\\"`).exec(transcript)?.[1] : undefined;
  const call = acted || !target
    ? {
      name: 'complete_step',
      arguments: JSON.stringify(acted ? { status: 'passed', summary: `Pressed ${button}.` } : { status: 'failed', summary: 'No such button.', errorCode: 'ACTION_FAILED' }),
    }
    : { name: 'tap', arguments: JSON.stringify({ target }) };
  return {
    id: `resp_${sequence}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: request.model,
    status: 'completed',
    output: [{ type: 'function_call', id: `fc_${sequence}`, call_id: `call_${sequence}`, status: 'completed', ...call }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
}

export async function fakeModel(): Promise<FakeModel> {
  const authorizations: string[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    if (request.method !== 'POST' || request.url !== '/v1/responses') return void response.writeHead(404).end();
    authorizations.push(request.headers.authorization ?? '');
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ResponsesRequest;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply(body, authorizations.length)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    authorizations,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
