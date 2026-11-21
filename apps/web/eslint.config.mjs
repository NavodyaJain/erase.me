import base, { browserGlobals } from '@erase/config/eslint/base';

export default [...base, { files: ['src/**/*.{ts,tsx}'], languageOptions: { globals: { ...browserGlobals } } }];
