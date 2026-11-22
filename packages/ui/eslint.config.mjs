import base, { browserGlobals } from '@erase/config/eslint/base';

export default [...base, { files: ['**/*.{ts,tsx}'], languageOptions: { globals: { ...browserGlobals } } }];
