import corePlugin from '@bric/rex-core/service-worker'

import spiderPlugin from '@bric/rex-spider/service-worker'
import googleAISpider from '@bric/rex-spider-google-ai/service-worker'

self['rexCorePlugin'] = corePlugin
self['rexSpiderPlugin'] = spiderPlugin
self['rexGoogleAIPlugin'] = googleAISpider


console.log(`Imported ${spiderPlugin} into service worker context...`)
console.log(`Imported ${googleAISpider} into service worker context...`)

corePlugin.setup()

spiderPlugin.registerSpider(googleAISpider)

self.setTimeout(() => {
    googleAISpider.checkNeedsUpdate().then((updated) => {
        console.log(`EXT: ${updated}`)
    })
}, 1000)

