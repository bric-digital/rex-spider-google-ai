import check from 'check-types'

import { Conversation, DateString } from '@bric/rex-types/types'

import rexCorePlugin, { EventPayload, dispatchEvent } from '@bric/rex-core/service-worker'

import rexSpiderPlugin, { REXSpider, REXSpiderCrawlResult } from '@bric/rex-spider/service-worker'

export class REXGoogleAISpider extends REXSpider {
  sleepDelayMs:number = 10000
  syncing:boolean = false
  lastSync:number = 0
  syncPeriod:number = 300000
  accessToken:string|null = null

  fetchUrls(): string[] {
    return []
  }

  name(): string {
    return 'Google AI Mode'
  }

  identifier(): string {
    return 'google-ai'
  }

  loginUrl(): string {
    return 'https://www.google.com/'
  }

  whitelistedUrls():string[] {
    return [
      '|https://www.google.com/|',
      '|https://www.google.com/httpservice/web/AimThreadsService/ListThreads?*',
    ]
  }

  fetchInitialUrls(): string[] {
    return []
  }

  checkLogin(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      fetch(this.loginUrl())
        .then((response: Response) => {
          if (response.ok) {
            response.text().then((rawHtml) => {
              if (rawHtml.includes('aria-label="Sign in"')) {
                resolve(false)
              } else {
                resolve(true)
              }
            })
          } else {
            resolve(false)
          }
        })
    })
  }

  parseChatList(rawChatListData:string) : Conversation[] {
    const parsed:Conversation[] = []
 
    try {
      if (rawChatListData.startsWith(')]}\'')) {
        rawChatListData = rawChatListData.substring(4).trim()

        const lines = rawChatListData.split(/\r?\n/)

        for (const line of lines) {
          if (line.startsWith('[[')) {
            const parsedLine = JSON.parse(line)

            console.log('parsedLine')
            console.log(parsedLine)

            for (const message of parsedLine) {
              if (check.array(message)) {
                for (const chat of message) {
                  const conversation:Conversation = {
                    identifier: `${chat[0][0]}_${chat[0][1]}`,
                    turns: [],
                    platform: 'google-ai-mode',
                    started: new DateString(chat[5][0]),
                    ended: new DateString(chat[5][0]),
                    metadata: chat
                  }

                  if (chat[6] !== null) {
                    conversation.ended = new DateString(chat[6][0])
                  }

                  parsed.push(conversation)
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(`[rex-spider-google-ai] Error parsing conversation:`)
      console.error(err)
    }

    return parsed
  }

  private signalComplete(crawledCount: number) {
    setTimeout(() => {
      dispatchEvent({
        name: 'pdk-app-event',
        event_name: 'rex-spider-google-ai-complete',
        event_details: {
          crawled_count: crawledCount,
          date: Date.now()
        }
      })
    }, 1100)
  }


  fetchChats(): Promise<Conversation[]> {
    return new Promise<Conversation[]>((resolve, reject) => {
      const requestId = Math.floor(Math.random() * (999999 - 10000)) + 10000

      const chatsUrl = `https://www.google.com/httpservice/web/AimThreadsService/ListThreads?hl=en&reqpld=[null,null,0]&msc=gwsclient&opi=${requestId}`

      const chats:Conversation[] = []

      fetch(chatsUrl, {
        method: 'GET',
        credentials: 'include'
      }).then((response: Response) => {
        if (!response.ok) {
          console.log(`[rex-spider-google-ai] List fetch failed (status ${response.status}).`)
          this.syncing = false
          this.signalComplete(0)
          reject(`List fetch failed (status ${response.status}).`)
        } else {
          response.text().then((rawBody) => {
            console.log('rawBody')
            console.log(rawBody)

            const parsed = this.parseChatList(rawBody)

            if (parsed !== null) {
              for (const chat of parsed) {
                chats.push(chat)
              }
            }

            resolve(chats)
          })
        }
      })
    })
  }

  checkNeedsUpdate(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (this.syncing) {
        console.log(`[rex-spider-google-ai] Still syncing. Skipping this round...`)
        resolve(true)
      } else {
        const fetchLastSync = {
          messageType: 'fetchValue',
          key: 'rex-spider-google-ai-last-sync'
        }

        rexCorePlugin.handleMessage(fetchLastSync, this, (response) => {
          let timestamp = 0

          if (response !== null) {
            timestamp = response
          }

          if (Date.now() < timestamp + this.syncPeriod) {
            console.log(`[rex-spider-google-ai] Too soon to sync again. Skipping this round...`)
            this.signalComplete(0)
            resolve(true)
          } else {
            const storeMessage = {
              messageType: 'storeValue',
              key: 'rex-spider-google-ai-last-sync',
              value: Date.now()
            }

            rexCorePlugin.handleMessage(storeMessage, this, (response) => { // eslint-disable-line @typescript-eslint/no-unused-vars
              this.syncing = true

              const homeUrl = 'https://www.google.com/'

              fetch(homeUrl, {
                method: 'GET',
                credentials: 'include', // Crucial property to send cookies
              }).then((response: Response) => {
                if (!response.ok) {
                  console.log(`[rex-spider-google-ai] Homepage fetch failed (status ${response.status}).`)

                  this.syncing = false
                  this.signalComplete(0)

                  resolve(true)
                } else {
                  response.text().then((rawHtml) => {
                    if (rawHtml.includes('"SNlM0e":"')) {
                      const startIndex = rawHtml.indexOf('"SNlM0e":"')

                      if (startIndex !== -1) {
                        const prefixStripped = rawHtml.substring(startIndex)

                        const tokens = prefixStripped.split('"')

                        if (tokens.length > 3) {
                          this.accessToken = tokens[3]
                        }
                      }

                      if (this.accessToken === null) {
                        this.syncing = false
                        this.signalComplete(0)

                        resolve(true)
                      } else {
                        this.fetchChats().then((chatList:Conversation[]) => {
                          let dispatched = 0

                          const uploadConversations = () => {
                            if (chatList.length <= 0) {
                              this.syncing = false
                              this.signalComplete(dispatched)
                              resolve(false)
                            } else {
                              const conversation = chatList.pop()

                              if (conversation !== undefined) {
                                if (conversation.started.value !== null) {
                                  const payload: EventPayload = {
                                    name: 'rex-conversation',
                                    date: conversation.started.value.epochMilliseconds,
                                    ...conversation
                                  }

                                  let when:DateString = conversation.started

                                  if (conversation.ended !== undefined) {
                                    when = conversation.ended
                                  }

                                  const uploadKey = `rex-spider-google-ai-upload-${conversation.identifier}-${when.toJSON()}`

                                  const fetchLastUpload = {
                                    messageType: 'fetchValue',
                                    key: uploadKey
                                  }

                                  rexCorePlugin.handleMessage(fetchLastUpload, this, (uploadValue) => {
                                    if (uploadValue === null) {
                                      dispatchEvent(payload)

                                      dispatched += 1

                                      const storeUpload = {
                                        messageType: 'storeValue',
                                        key: uploadKey,
                                        value: Date.now()
                                      }

                                      rexCorePlugin.handleMessage(storeUpload, this, (response) => { // eslint-disable-line @typescript-eslint/no-unused-vars
                                        uploadConversations()
                                      })
                                    } else {
                                      uploadConversations()
                                    }
                                  })
                                }
                              }
                            }
                          }

                          uploadConversations()
                        })
                      }
                    }
                  })
                }
              })
              .catch((err) => {
                console.error(`[rex-spider-google-ai] Error encountered fetching conversations:`)
                console.error(err)

                this.syncing = false
                this.signalComplete(0)

                resolve(true)
              })
            })
          }
        })
      }
    })
  }

    doBackgroundCrawl():Promise<REXSpiderCrawlResult> {
      return new Promise<REXSpiderCrawlResult>((resolve) => {
        const fetchLastSync = {
          messageType: 'fetchValue',
          key: 'rex-spider-google-ai-last-sync'
        }

        rexCorePlugin.handleMessage(fetchLastSync, this, (response) => {
          let lastSynchTs = 0

          if (response !== null) {
            lastSynchTs = response
          }

          const when:Date = new Date(lastSynchTs)

          if (this.syncing) {
            console.log(`[rex-spider-google-ai] Still syncing. Skipping this round...`)

            resolve({
              sitesCrawled: [this.identifier()],
              issues: [{
                url: this.loginUrl(),
                message: `Still synching since ${when}.`
              }]
            })
          } else {
              if (Date.now() < lastSynchTs + this.syncPeriod) {
                console.log(`[rex-spider-google-ai] Too soon to sync again. Skipping this round...`)
                this.signalComplete(0)

                resolve({
                  sitesCrawled: [this.identifier()],
                  issues: [{
                    url: this.loginUrl(),
                    message: `Too soon to synch since ${when} (period = ${this.syncPeriod}).`
                  }]
                })
              } else {
                const storeMessage = {
                  messageType: 'storeValue',
                  key: 'rex-spider-google-ai-last-sync',
                  value: Date.now()
                }

                rexCorePlugin.handleMessage(storeMessage, this, (response) => { // eslint-disable-line @typescript-eslint/no-unused-vars
                  this.syncing = true

                  const homeUrl = 'https://www.google.com/'

                  fetch(homeUrl, {
                    method: 'GET',
                    credentials: 'include', // Crucial property to send cookies
                  }).then((response: Response) => {
                    if (!response.ok) {
                      console.log(`[rex-spider-google-ai] Homepage fetch failed (status ${response.status}).`)

                      this.syncing = false
                      this.signalComplete(0)

                      resolve({
                        sitesCrawled: [this.identifier()],
                        issues: [{
                          url: this.loginUrl(),
                          message: `Unable to fetch ${homeUrl}. Status code = ${response.status}.`
                        }]
                      })
                    } else {
                      response.text().then((rawHtml) => {
                        if (rawHtml.includes('"SNlM0e":"')) {
                          const startIndex = rawHtml.indexOf('"SNlM0e":"')

                          if (startIndex !== -1) {
                            const prefixStripped = rawHtml.substring(startIndex)

                            const tokens = prefixStripped.split('"')

                            if (tokens.length > 3) {
                              this.accessToken = tokens[3]
                            }
                          }

                          if (this.accessToken === null) {
                            this.syncing = false
                            this.signalComplete(0)

                            resolve({
                              sitesCrawled: [this.identifier()],
                              issues: [{
                                url: this.loginUrl(),
                                message: `User not logged in.`
                              }]
                            })
                          } else {
                            this.fetchChats().then((chatList:Conversation[]) => {
                              let dispatched = 0

                              const uploadConversations = () => {
                                if (chatList.length <= 0) {
                                  this.syncing = false
                                  this.signalComplete(dispatched)

                                  resolve({
                                    sitesCrawled: [this.identifier()],
                                    issues: []
                                  })

                                } else {
                                  const conversation = chatList.pop()

                                  if (conversation !== undefined) {
                                    if (conversation.started.value !== null) {
                                      const payload: EventPayload = {
                                        name: 'rex-conversation',
                                        date: conversation.started.value.epochMilliseconds,
                                        ...conversation
                                      }

                                      let when:DateString = conversation.started

                                      if (conversation.ended !== undefined) {
                                        when = conversation.ended
                                      }

                                      const uploadKey = `rex-spider-google-ai-upload-${conversation.identifier}-${when.toJSON()}`

                                      const fetchLastUpload = {
                                        messageType: 'fetchValue',
                                        key: uploadKey
                                      }

                                      rexCorePlugin.handleMessage(fetchLastUpload, this, (uploadValue) => {
                                        if (uploadValue === null) {
                                          dispatchEvent(payload)

                                          dispatched += 1

                                          const storeUpload = {
                                            messageType: 'storeValue',
                                            key: uploadKey,
                                            value: Date.now()
                                          }

                                          rexCorePlugin.handleMessage(storeUpload, this, (response) => { // eslint-disable-line @typescript-eslint/no-unused-vars
                                            uploadConversations()
                                          })
                                        } else {
                                          uploadConversations()
                                        }
                                      })
                                    }
                                  }
                                }
                              }

                              uploadConversations()
                            })
                          }
                        }
                      })
                    }
                  })
                  .catch((err) => {
                    console.error(`[rex-spider-google-ai] Error encountered fetching conversations:`)
                    console.error(err)

                    this.syncing = false
                    this.signalComplete(0)

                    resolve({
                      sitesCrawled: [this.identifier()],
                      issues: [{
                        url: this.loginUrl(),
                        message: `Error fetching conversations: ${err}.`
                      }]
                    })
                  })
                })
              }
            }
        })
      })
    }

}

const googleAISpider = new REXGoogleAISpider()

rexSpiderPlugin.registerSpider(googleAISpider)

export default googleAISpider