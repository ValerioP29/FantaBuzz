import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['server/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        process: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        setImmediate: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['client/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
        Toastify: 'readonly',
        io: 'readonly',
        crypto: 'readonly',
        URLSearchParams: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        location: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'off',
    },
  },
];
