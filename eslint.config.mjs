import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import nextVitals from 'eslint-config-next/core-web-vitals';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const reactFiles = ['apps/web/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      '**/playwright-report/**',
      '**/test-results/**',
      'packages/db/src/generated/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // Next.js, React and accessibility rules for the web app and the shared components.
  ...nextVitals.map((config) => ({ ...config, files: reactFiles })),
  {
    files: reactFiles,
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      // App Router only: there is no pages/ directory.
      '@next/next/no-html-link-for-pages': 'off',
      // Styling goes through CSS Modules and design tokens, never inline styles.
      'react/forbid-dom-props': ['error', { forbid: ['style'] }],
      'react/forbid-component-props': ['error', { forbid: ['style'] }],
    },
  },
  {
    // Code run by browsers (docs/spec.md, "Navigateurs"): a regexp lookbehind
    // throws a SyntaxError in Safari before 16.4, even when built from a string.
    files: [...reactFiles, 'packages/shared/src/**/*.ts'],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...[
          'Literal[regex.pattern=/\\(\\?<[=!]/]',
          'Literal[value=/\\(\\?<[=!]/]',
          'TemplateElement[value.raw=/\\(\\?<[=!]/]',
        ].map((selector) => ({
          selector,
          message: 'No regexp lookbehind: Safari before 16.4 (iOS 15 and 16) rejects it.',
        })),
      ],
    },
  },
  {
    // Nest decorator metadata needs runtime imports of injected classes.
    files: ['apps/api/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  prettier,
);
