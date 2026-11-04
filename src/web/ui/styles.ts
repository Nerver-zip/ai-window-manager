import { BASE_CSS } from './styles/base.js';
import { LOGS_CSS } from './styles/logs.js';
import { OVERVIEW_CSS } from './styles/overview.js';
import { PROVIDER_PICKER_CSS } from './styles/provider-picker.js';
import { SCHEDULE_CSS } from './styles/schedule.js';
import { SETTINGS_CSS } from './styles/settings.js';
import { SHELL_CSS } from './styles/shell.js';
import { USAGE_CSS } from './styles/usage.js';

// Served as a same-origin stylesheet; no inline styles or external assets.
export const APP_CSS = [
  BASE_CSS,
  SHELL_CSS,
  PROVIDER_PICKER_CSS,
  OVERVIEW_CSS,
  USAGE_CSS,
  SCHEDULE_CSS,
  LOGS_CSS,
  SETTINGS_CSS,
].join('\n');
