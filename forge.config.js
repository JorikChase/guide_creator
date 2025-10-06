module.exports = {
  packagerConfig: {
    asar: true,
    // The icon for the application, without the file extension.
    // Forge will automatically use .ico for Windows and .icns for macOS.
    icon: 'logo/logo',
    // Specifies an array of files or directories to be copied into the app's resources directory.
    // This ensures your 'bin' directory with ffmpeg is included in the packaged app.
    extraResource: [
      'bin',
    ],
  },
  rebuildConfig: {},
  makers: [
    // Maker for creating a Windows installer
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        // The ICO file to use as the icon for the generated Setup.exe
        setupIcon: 'logo/logo.ico',
      },
    },
    // Maker for creating a ZIP archive for macOS and Windows
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32'],
    },
    // Makers for creating Linux packages
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
};
