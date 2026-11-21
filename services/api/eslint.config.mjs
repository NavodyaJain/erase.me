import base from '@erase/config/eslint/base';

export default [...base, { ignores: ['src/db/migrations/**'] }];
