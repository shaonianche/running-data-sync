#!/usr/bin/env node
import process from 'node:process'
import { runCli } from './index.js'

const exitCode = await runCli(process.argv.slice(2))
process.exitCode = exitCode
