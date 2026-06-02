function readPackage(pkg, context) {
  // Override build script execution for specific packages
  if (pkg.name === '@byterover/cipher') {
    // Allow all build scripts for cipher
    return { ...pkg };
  }
  return pkg;
}
module.exports = { hooks: { readPackage } };
