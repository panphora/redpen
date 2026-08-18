import { defaultReporter, summaryReporter } from '@web/test-runner';
import { playwrightLauncher } from '@web/test-runner-playwright';

// rootDir reaches one level up so a test can import clayjs's own region-policy.
// The save-domain projection these tests compare is the host's definition of
// what reaches the file, and a copy of it kept here would be written by whoever
// wrote redpen's marking — it would agree with the marking for the same wrong
// reason, and pass while the file is being corrupted.
export default {
  rootDir: '..',
  nodeResolve: true,
  files: 'test/**/*.test.js',
  browsers: [playwrightLauncher({ product: 'chromium' })],
  reporters: [summaryReporter(), defaultReporter()],
};
