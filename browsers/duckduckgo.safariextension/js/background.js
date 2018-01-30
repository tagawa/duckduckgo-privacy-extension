/*
 * Copyright (C) 2012, 2016 DuckDuckGo, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


var debugRequest = false;
var trackers = require('trackers');
var utils = require('utils');
var settings = require('settings');
var https = require('https');
let browser = 'safari'

function Background() {
  $this = this;
}

var background = new Background();

var handleMessage = function (message) {
    if (message.name === 'canLoad') {
        return onBeforeRequest(message)
    }
}

// when the extension first installs, check for any existing tabs
// and create a background tab so we can show the correct site in the popup
settings.ready().then(() => {    
    if(!localStorage['installed']) {
        
        localStorage['installed'] = true
        
        ATB.onInstalled()

        settings.removeSetting('HTTPSwhitelisted')

        let activeTabIndex = 0 
        let showPostinstallPage = false

        safari.application.browserWindows.forEach((safariWindow) => {
            safariWindow.tabs.forEach((safariTab) => {
                // create a tab id and store in safari tab
                safariTab.ddgTabId = Math.floor(Math.random() * (10000000 - 10 + 1)) + 10

                // only show postinstall page if one of the existing tabs is ddg with install param or the safari gallery page
                if (safariTab.url.match(/duckduckgo.com\/\?t=hf|safari-extensions.apple.com\/details\/\?id=com.duckduckgo.safari/)) {
                    showPostinstallPage = true
                }

                // make a fake request obj so we can use tabManager to handle creating and storing the tab
                let req = {
                    url: safariTab.url,
                    target: safariTab,
                    message: {currentURL: safariTab.url},
                }
                tabManager.create(req)
            })
        })

        // open post install page
        if (showPostinstallPage) {
            
            let activeTabIdx = utils.getSafariTabIndex(safari.application.activeBrowserWindow.activeTab)
            safari.application.activeBrowserWindow.openTab().url = 'https://duckduckgo.com/app?post=1'
            
            // reactivate previous tab
            safari.application.activeBrowserWindow.tabs[activeTabIdx].activate()
        }
    }
})

/** 
 * Before each request:
 * - Add ATB param
 * - Block tracker requests
 * - Upgrade http -> https per HTTPS Everywhere rules
 */
var onBeforeRequest = function (requestData) { 
    let potentialTracker = requestData.message.potentialTracker
    let currentURL = requestData.message.mainFrameURL

    if (!(currentURL && potentialTracker)) return

    //console.log(`REQUEST: page: ${currentURL} tabId: ${requestData.message.tabId} tracker: ${potentialTracker}`)

    // for safari we need to create the tab obj in here. The tab open event doesn't
    // contain any tab specific data for us to do this in tabManager
    
    let tabId = tabManager.getTabId(requestData)
    let thisTab = tabManager.get({tabId: tabId})
    let isMainFrame = requestData.message.frame === 'main_frame'

    // if it's preloading a site in the background and the url changes, delete and recreate the tab:
    if (thisTab && thisTab.url !== requestData.message.mainFrameURL) {
        tabManager.delete(tabId)
        thisTab = tabManager.create({
            url: requestData.message.mainFrameURL,
            target: requestData.target
        })
        console.log('onBeforeRequest DELETED AND RECREATED TAB because of url change:', thisTab)
    }

    if (!thisTab && isMainFrame) {
        thisTab = tabManager.create(requestData)
        console.log('onBeforeRequest CREATED TAB:', thisTab)
    }

    if(thisTab.site.isBroken) {
        console.log('temporarily skip tracker blocking for site: '
                    + utils.extractHostFromURL(thisTab.url) + '\n'
                    + 'more info: https://github.com/duckduckgo/content-blocking-whitelist')
        return
    }

    var tracker = trackers.isTracker(potentialTracker, thisTab, requestData);
    
    if (tracker) {
        thisTab.site.addTracker(tracker)
        thisTab.addToTrackers(tracker)

        if (!thisTab.site.whitelisted && tracker.block) {
            thisTab.addOrUpdateTrackersBlocked(tracker)

            if (tracker.parentCompany !== 'unknown') Companies.add(tracker.parentCompany)

            console.info(`${thisTab.site.domain} [${tracker.parentCompany }] ${tracker.url}`);

            // don't update the popup until the tab is no longer hidden:
            if (!requestData.message.hidden) {
                safari.extension.popovers[0].contentWindow.location.reload()
            }

            if (tracker.redirectUrl) {
                requestData.message = { redirectUrl: tracker.redirectUrl }
            } else {
                requestData.message = { cancel: true }
            }
            return
        }
    }   
}


/**
 * Before navigating to a new page,
 * check whether we should upgrade to https
 */
var onBeforeNavigation = function (e) {
    //console.log(`onBeforeNavigation ${e.url} ${e.target.url}`)

    if (!e.url || !e.target || e.target.url === 'about:blank' || e.url.match(/com.duckduckgo.safari/)) return

    const url = e.url
    const isMainFrame = true // always main frame in this handler
    const tabId = tabManager.getTabId(e)

    let thisTab = tabId && tabManager.get({tabId: tabId})

    // if a tab already exists, but the url is different,
    // delete it and recreate for the new url
    if (thisTab && thisTab.url !== url) {
        tabManager.delete(tabId)
        thisTab = null
        console.log('onBeforeNavigation DELETED TAB because url did not match')
    }

    if (!thisTab) {
        thisTab = tabManager.create(e)
        //console.log('onBeforeNavigation CREATED TAB:', thisTab)
    }

    // same logic from /shared/js/background.js

    // site is required to be there:
    if (!thisTab || !thisTab.site) {
        console.log('HTTPS: no tab or tab site found for: ', tabId, thisTab)
        return
    }
    
    // skip upgrading broken sites:
    if (thisTab.site.isBroken) {
        console.log('HTTPS: temporarily skip upgrades for: ' + url)
        return
    }

    // skip trying again if we've already tried upgrading this url
    if (thisTab.hasUpgradedUrlAlready(url)) {
        console.log('HTTPS: skipping upgrade to avoid redirect loops', url)
        return
    }

    const upgradedUrl = https.getUpgradedUrl(url, thisTab, isMainFrame)

    if (url.toLowerCase() !== upgradedUrl.toLowerCase()) {
        console.log('HTTPS: upgrade request url to ' + upgradedUrl)
        thisTab.upgradedHttps = true
        thisTab.addHttpsUpgradeRequest(upgradedUrl, url)

        e.preventDefault()
        e.target.url = upgradedUrl
    }
}

var onBeforeSearch = function (evt) {
    if (!safari.extension.settings.default_search_engine) return

    let query = evt.query;
    let DDG_URL = 'https://duckduckgo.com/?q='

    function checkURL(url){
      var expr = /^(^|\s)((https?:\/\/)?[\w-]+(\.[\w-]+)+\.?(:\d+)?(\/\S*)?)/i;
      var regex = RegExp(expr);
      var localhost = RegExp(/^(https?:\/\/)?localhost(:\d+)?/i)
      var about = RegExp(/(about|safari-extension):.*/);
      var nums = RegExp(/^(\d+\.\d+).*/i);
      return (url.match(regex) || url.match(about) || url.match(localhost)) && !url.match(nums) ;
    }

    if (!checkURL(query)) {
        evt.preventDefault();
        let url = DDG_URL + encodeURIComponent(query) + '&bext=msl';
        let atb = settings.getSetting('atb')
        if (atb) {
              url = url + '&atb=' + atb
        }   
        evt.target.url = url
    }
}

safari.application.addEventListener("message", handleMessage, true);
safari.application.addEventListener("beforeNavigate", onBeforeNavigation, true);
safari.application.addEventListener('beforeSearch', onBeforeSearch, true);
