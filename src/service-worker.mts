import check from 'check-types'

import { Conversation, DateString } from '@bric/rex-types/types'

import { EventPayload, dispatchEvent } from '@bric/rex-core/service-worker'

import rexSpiderPlugin, { REXSpider, REXSpiderCrawlResult, REXSpiderCrawlInspection } from '@bric/rex-spider/service-worker'

export class REXGoogleAISpider extends REXSpider {
  accessToken: string | null = null

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

  allowedUrls():string[] {
    return [
      '^https://www.google.com/$',
      '^https://www.google.com/httpservice/web/AimThreadsService/ListThreads\?.*',
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

  fetchChats(): Promise<REXSpiderCrawlInspection[]> {
    return new Promise<REXSpiderCrawlInspection[]>((resolve, reject) => {
      const requestId = Math.floor(Math.random() * (999999 - 10000)) + 10000

      const chatsUrl = `https://www.google.com/httpservice/web/AimThreadsService/ListThreads?hl=en&reqpld=[null,null,0]&msc=gwsclient&opi=${requestId}`

      const chats:REXSpiderCrawlInspection[] = []

      fetch(chatsUrl, {
        method: 'GET',
        credentials: 'include'
      }).then((response: Response) => {
        if (!response.ok) {
          reject(`List fetch failed (status ${response.status}).`)
        } else {
          response.text().then((rawBody) => {
            console.log(`[rex-spider-google-ai] rawBody: ${rawBody}`)

            const parsed:Conversation[] = this.parseChatList(rawBody)

            const checkNextConversation = () => {
              if (parsed.length === 0) {
                resolve(chats)
              } else {
                const nextConversation = parsed.pop()

                if (nextConversation !== undefined && nextConversation.ended !== undefined) {
                  this.crawlWindowContains(nextConversation.ended.timestamp()).then((include) => {
                    if (nextConversation.ended !== undefined && include) {
                      this.checkIfAlreadyTransmitted(nextConversation.identifier, nextConversation.ended).then((transmitted:boolean) => {
                        if (nextConversation.ended !== undefined) {
                          if (transmitted) {
                            chats.push({
                              id: nextConversation.identifier,
                              refresh: false,
                              conversation: nextConversation,
                              lookupDate: nextConversation.ended
                            })
                          } else {
                            chats.push({
                              id: nextConversation.identifier,
                              refresh: true,
                              conversation: nextConversation,
                              lookupDate: nextConversation.ended
                            })
                          }
                        }

                        checkNextConversation()
                      })
                    } else {
                      checkNextConversation()
                    }
                  })
                } else {
                  checkNextConversation()
                }
              }
            }

            checkNextConversation()
          })
        }
      })
    })
  }

  doBackgroundCrawl():Promise<REXSpiderCrawlResult> {
    return new Promise<REXSpiderCrawlResult>((resolve) => {
      super.doBackgroundCrawl().then((crawlResult:REXSpiderCrawlResult) => {
        const homeUrl = 'https://www.google.com/'

        const crawledIds:string[] = []

        fetch(homeUrl, {
          method: 'GET',
          credentials: 'include', // Crucial property to send cookies
        }).then((response: Response) => {
          if (!response.ok) {
            this.signalCrawlComplete(-1, [], `Unable to fetch ${homeUrl}. Status code = ${response.status}.`)

            crawlResult.issues.push({
              url: this.loginUrl(),
              message: `Unable to fetch ${homeUrl}. Status code = ${response.status}.`
            })

            resolve(crawlResult)
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
                  this.signalCrawlComplete(-1, [], `User not logged in.`)

                  crawlResult.issues.push({
                    url: this.loginUrl(),
                    message: `User not logged in.`
                  })

                  resolve(crawlResult)
                } else {
                  this.fetchChats().then((chatList:REXSpiderCrawlInspection[]) => {
                    let dispatched = 0

                    const uploadConversations = () => {
                      if (chatList.length <= 0) {
                        this.signalCrawlComplete(dispatched, crawledIds, 'Crawl successful')

                        resolve(crawlResult)
                      } else {
                        const inspectionRecord:REXSpiderCrawlInspection | undefined= chatList.pop()

                        if (inspectionRecord !== undefined && inspectionRecord.conversation !== undefined) {
                          const conversation:Conversation = inspectionRecord.conversation

                          if (conversation.ended !== undefined && conversation.ended.value !== null) {
                            const payload: EventPayload = {
                              name: 'rex-conversation',
                              date: conversation.ended.value.epochMilliseconds,
                              ...conversation
                            }

                            let when:DateString | undefined = conversation.started

                            if (conversation.ended !== undefined) {
                              when = conversation.ended
                            }

                            crawledIds.push(conversation.identifier)

                            if (when !== undefined) {
                              if (inspectionRecord.refresh) {
                                this.checkIfAlreadyTransmitted(inspectionRecord.id, inspectionRecord.lookupDate).then((transmitted:boolean) => { // Possibly redundant
                                  if (transmitted === false) {
                                    dispatchEvent(payload)

                                    dispatched += 1

                                    this.logTransmitted(inspectionRecord.id, inspectionRecord.lookupDate).then(() => {
                                      uploadConversations()
                                    })
                                  } else {
                                    uploadConversations()
                                  }
                                })
                              } else {
                                uploadConversations()
                              }
                            } else {
                              uploadConversations()
                            }
                          }
                        } else {
                          uploadConversations()
                        }
                      }
                    }

                    uploadConversations()
                  })
                }
              } else {
                this.signalCrawlComplete(-1, [], `SNlM0e token not found in Google home page.`)

                crawlResult.issues.push({
                  url: this.loginUrl(),
                  message: `SNlM0e token not found in Google home page.`
                })

                resolve(crawlResult)
              }
            })
          }
        })
        .catch((err) => {
          this.signalCrawlComplete(-1, [], `Error fetching conversations: ${err}.`)

          crawlResult.issues.push({
            url: this.loginUrl(),
            message: `Error fetching conversations: ${err}.`
          })

          resolve(crawlResult)
        })
      })
    })
  }
}

const googleAISpider = new REXGoogleAISpider()

rexSpiderPlugin.registerSpider(googleAISpider)

export default googleAISpider