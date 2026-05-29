// Root ESLint flat config. ESLint 9 resolves this from each package's cwd upward,
// so all workspaces share one config. Package-specific overrides can extend it locally.
import config from '@erp/config/eslint';

export default config;
