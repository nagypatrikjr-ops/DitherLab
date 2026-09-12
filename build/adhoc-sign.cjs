// @ts-check
const { execFileSync } = require('node:child_process');
const path = require('node:path');

/**
 * electron-builder afterSign hook. Without a Developer ID certificate the app
 * would ship with no valid signature, which Apple Silicon Macs report as
 * "damaged". An ad-hoc signature turns that into the normal "Open Anyway"
 * prompt for downloaded apps.
 *
 * @param {import('electron-builder').AfterPackContext} context
 */
exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
