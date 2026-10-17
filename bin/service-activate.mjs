#!/usr/bin/env node
import { activateService } from '../dist/server/service-activation.js';
await activateService(process.argv[2]);
