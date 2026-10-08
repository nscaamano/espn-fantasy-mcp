#!/usr/bin/env node
// stdio entry point. Config problems (no leagues.json, bad ids) surface as tool
// errors rather than a failed launch, so the user sees the message in their client.

import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { serviceLoader } from "./load.js";
import { createServer } from "./server.js";

const server = createServer(serviceLoader());
await server.connect(new StdioServerTransport());
