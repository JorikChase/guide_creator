module.exports = {
  packagerConfig: {
    asar: true,
    // The icon for the application, without the file extension.
    icon: 'logo/logo',
    // Specifies an array of files or directories to be copied into the app's resources directory.
    extraResource: [
      'bin',
    ],
    // Critical: Added from package.json to ensure Adobe OAuth deep linking works!
    protocols: [
      {
        name: "Adobe Auth",
        schemes: [
          "adobe+a1385a5a99e3cc61b65afdc24dd68201301fa743"
        ]
      }
    ]
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        setupIcon: 'logo/logo.ico',
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32'],
    },
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