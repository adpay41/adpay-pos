// Root ESLint config for every workspace package (ESLint finds it by walking up from each package).
//
// Two rules here encode CLAUDE.md and are enforced in CI rather than by review:
//   - Nothing outside packages/api/payments/finix/ imports Finix (ADR 0003).
//   - No float parsing of amounts in domain code (ADR 0004).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Anchored regexes, not gitignore-style globs: a glob like `finix-*` would also match a path
// segment of our own adapter (./finix/finix-provider) and forbid the registry from importing it.
const FINIX_VENDOR_PATTERNS = [
  {
    regex: '^(finix|finix-[^/]+|@finix[^/]*/[^/]+)(/.*)?$',
    message: 'Only packages/api/payments/finix/ may import Finix (ADR 0003). Depend on PaymentProvider.',
  },
];

const FINIX_ADAPTER_PATTERNS = [
  {
    regex: '(^|/)payments/finix(/|$)|^\\./finix(/|$)',
    message:
      'Only packages/api/payments/index.ts may reach the Finix adapter; everything else uses PaymentProvider.',
  },
];

const NO_FINIX_ENV = {
  selector:
    "MemberExpression[object.type='MemberExpression'][object.object.name='process'][object.property.name='env'][property.name=/^FINIX_/]",
  message: 'FINIX_* config is read only inside packages/api/payments/finix/ (ADR 0003).',
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.expo/**',
      '**/web-build/**',
      '**/coverage/**',
      'infra/**',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-imports': ['error', { patterns: [...FINIX_VENDOR_PATTERNS, ...FINIX_ADAPTER_PATTERNS] }],
      'no-restricted-syntax': ['error', NO_FINIX_ENV],
    },
  },
  // Domain code: money is integer cents, so parsing a float is always a bug here.
  {
    files: ['packages/shared/**/*.ts', 'packages/api/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Money is integer cents (ADR 0004). Use parseUsdToCents from @adpay/shared.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Number', property: 'parseFloat', message: 'Money is integer cents (ADR 0004).' },
      ],
    },
  },
  // The payments registry is the single place allowed to construct the Finix adapter.
  {
    files: ['packages/api/payments/index.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: FINIX_VENDOR_PATTERNS }] },
  },
  // Inside the adapter itself, Finix is fair game.
  {
    files: ['packages/api/payments/finix/**'],
    rules: { 'no-restricted-imports': 'off', 'no-restricted-syntax': 'off' },
  },
  {
    files: ['**/*.cjs', '**/metro.config.js', '**/babel.config.js'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
