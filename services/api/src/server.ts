import { reportStartupFailure, start } from './start.js';

start().catch(reportStartupFailure);
