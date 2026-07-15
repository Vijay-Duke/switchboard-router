#!/usr/bin/env node

const { runClaudeSwitchboard } = require("./src/cli/claudeLauncher");

process.exitCode = runClaudeSwitchboard();
