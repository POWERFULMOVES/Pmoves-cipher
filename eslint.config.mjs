import {includeIgnoreFile} from '@eslint/compat'
import oclif from 'eslint-config-oclif'
import prettier from 'eslint-config-prettier'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const gitignorePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.gitignore')

export default [
  includeIgnoreFile(gitignorePath),
  // The byterover-packages submodule has its own ESLint config and tsconfig
  // (referencing @workspace/* packages) — skip it from the root lint run.
  {ignores: ['packages/**']},
  ...oclif,
  prettier,
  {
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: './tsconfig.json',
        },
      },
    },
  },
  // Node built-ins availability is governed by the shipped Docker image, not
  // the oclif engines range; the runtime (Node 20+) provides global fetch.
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      'n/no-unsupported-features/node-builtins': 'off',
    },
  },
  // The PMOVES shim speaks snake_case wire contracts (A2A agent cards, Qdrant
  // payloads, health/NATS facts). Local identifiers stay camelCase.
  {
    files: ['src/pmoves/**/*.ts'],
    rules: {
      camelcase: ['error', {properties: 'never'}],
      // `express.Router()` is a factory, not a constructor.
      'new-cap': ['error', {capIsNewExceptions: ['Router']}],
    },
  },
  // Web UI (browser environment) — allow browser globals and React naming conventions
  {
    files: ['src/webui/**/*.ts', 'src/webui/**/*.tsx'],
    languageOptions: {
      globals: {
        document: 'readonly',
        fetch: 'readonly',
        sessionStorage: 'readonly',
        window: 'readonly',
      },
    },
    rules: {
      'n/no-unsupported-features/node-builtins': 'off',
      // Prevent Web UI from importing server code directly
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/server/**', '../server/**', '../../server/**', '../../../server/**', '../../../../server/**'],
              message: 'Web UI should not import from server. Use transport events or feature APIs instead.',
            },
            {
              group: ['**/agent/**', '../agent/**', '../../agent/**', '../../../agent/**', '../../../../agent/**'],
              message: 'Web UI should not import from agent. Use transport events or feature APIs instead.',
            },
            {
              group: ['**/oclif/**', '../oclif/**', '../../oclif/**', '../../../oclif/**', '../../../../oclif/**'],
              message: 'Web UI should not import from oclif. Use transport events or feature APIs instead.',
            },
            {
              group: ['**/tui/**', '../tui/**', '../../tui/**', '../../../tui/**', '../../../../tui/**'],
              message: 'Web UI should not import from tui. Use transport events or feature APIs instead.',
            },
          ],
        },
      ],
      'unicorn/filename-case': 'off',
    },
  },
  // Prevent TUI from importing server code directly
  {
    files: ['src/tui/**/*.ts', 'src/tui/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/server/**', '../server/**', '../../server/**', '../../../server/**', '../../../../server/**'],
              message: 'TUI should not import from server. Use transport events or feature APIs instead.',
            },
            {
              group: ['**/agent/**', '../agent/**', '../../agent/**', '../../../agent/**', '../../../../agent/**'],
              message: 'TUI should not import from agent. Use transport events or feature APIs instead.',
            },
            {
              group: ['**/oclif/**', '../oclif/**', '../../oclif/**', '../../../oclif/**', '../../../../oclif/**'],
              message: 'TUI should not import from oclif. Use transport events or feature APIs instead.',
            },
          ],
        },
      ],
    },
  },
]
