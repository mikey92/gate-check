import {defineCliConfig} from 'sanity/cli'

export default defineCliConfig({
  api: {
    projectId: 'nkpgzr3t',
    dataset: 'production'
  },
  studioHost: 'gate-check-powerbanks',
  deployment: {
    appId: 'euonwwv1cbqbary8m49lrgf7',
    /**
     * Enable auto-updates for studios.
     * Learn more at https://www.sanity.io/docs/studio/latest-version-of-sanity#k47faf43faf56
     */
    autoUpdates: true,
  },
})
