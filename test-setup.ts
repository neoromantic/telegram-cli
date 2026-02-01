/**
 * Test setup file for Bun test runner
 * This file is preloaded before tests to ensure proper module initialization
 */

// Ensure test environment is set before any imports
process.env.BUN_ENV = 'test'
process.env.NODE_ENV = 'test'

// Pre-import modules with barrel exports to ensure they're properly resolved
// This helps prevent race conditions during parallel test loading
// Import order matters - import modules without side effects first
import './src/types/index'
import './src/db/index'
import './src/utils/output'
import './src/services/telegram'
