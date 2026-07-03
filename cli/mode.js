'use strict';
// Data source mode.
//  - dummy: read bundled fixtures only (default; never touches real files)
//  - real : read actual ~/.claude, ~/.codex, ~/.agents paths
//
// Security guard: real mode requires explicit AAD_ALLOW_REAL=1.

function realAllowed() {
  return process.env.AAD_ALLOW_REAL === '1';
}

let current = process.env.AAD_MODE === 'real' && realAllowed() ? 'real' : 'dummy';

function getMode() {
  return current;
}

function setMode(m) {
  if (m === 'real') {
    if (!realAllowed()) return current;
    current = 'real';
  } else if (m === 'dummy') {
    current = 'dummy';
  }
  return current;
}

module.exports = { getMode, setMode, realAllowed };
