// @ts-check

/**
 * @param {{ isCompatible: boolean, hasActiveConnection: boolean }} options
 */
export function getProviderModelToolbarActions({ isCompatible, hasActiveConnection }) {
  const showImport = !isCompatible;
  const showVerify = hasActiveConnection;
  const showBulkControls = !isCompatible;

  return {
    showToolbar: showImport || showVerify || showBulkControls,
    showImport,
    showVerify,
    showBulkControls,
  };
}
