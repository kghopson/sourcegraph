import { from, Subject, Unsubscribable } from 'rxjs'
import { filter, map, mergeMap } from 'rxjs/operators'
import { Controller as BaseController } from '../api/client/controller'
import { Environment } from '../api/client/environment'
import { ExecuteCommandParams } from '../api/client/providers/command'
import { InitData } from '../api/extension/extensionHost'
import { Contributions, MessageType } from '../api/protocol'
import { createConnection } from '../api/protocol/jsonrpc2/connection'
import { BrowserConsoleTracer, Trace } from '../api/protocol/jsonrpc2/trace'
import { registerBuiltinClientCommands, updateConfiguration } from '../commands/commands'
import { Notification } from '../notifications/notification'
import { PlatformContext } from '../platform/context'
import { ExtensionManifest } from '../schema/extension.schema'
import { SettingsCascade } from '../settings/settings'
import { asError, isErrorLike } from '../util/errors'
import { ConfiguredExtension, isExtensionEnabled } from './extension'
import { ExtensionStatus } from './ExtensionStatus'

/**
 * Extends the {@link BaseController} class to add functionality that is useful to this package's consumers.
 */
export class Controller extends BaseController<ConfiguredExtension, SettingsCascade> {
    /**
     * Global notification messages that should be displayed to the user, from the following sources:
     *
     * - window/showMessage notifications from extensions
     * - Errors thrown or returned in command invocation
     */
    public readonly notifications = new Subject<Notification>()

    /**
     * Executes the command (registered in the CommandRegistry) specified in params. If an error is thrown, the
     * error is returned *and* emitted on the {@link Controller#notifications} observable.
     *
     * All callers should execute commands using this method instead of calling
     * {@link sourcegraph:CommandRegistry#executeCommand} directly (to ensure errors are
     * emitted as notifications).
     */
    public executeCommand(params: ExecuteCommandParams): Promise<any> {
        return this.registries.commands.executeCommand(params).catch(err => {
            this.notifications.next({ message: err, type: MessageType.Error, source: params.command })
            return Promise.reject(err)
        })
    }
}

/**
 * React props or state containing the controller. There should be only a single controller for the whole
 * application.
 */
export interface ExtensionsControllerProps {
    /**
     * The controller, which is used to communicate with the extensions and manages extensions based on the
     * environment.
     */
    extensionsController: Controller
}

/**
 * Filter the environment to omit extensions that should not be activated (based on their manifest's
 * activationEvents).
 */
function environmentFilter(
    nextEnvironment: Environment<ConfiguredExtension, SettingsCascade>
): Environment<ConfiguredExtension, SettingsCascade> {
    return {
        ...nextEnvironment,
        extensions:
            nextEnvironment.extensions &&
            nextEnvironment.extensions.filter(x => {
                try {
                    if (!isExtensionEnabled(nextEnvironment.configuration.final, x.id)) {
                        return false
                    } else if (!x.manifest) {
                        console.warn(
                            `Extension ${x.id} was not found. Remove it from settings to suppress this warning.`
                        )
                        return false
                    } else if (isErrorLike(x.manifest)) {
                        console.warn(asError(x.manifest))
                        return false
                    } else if (!x.manifest.activationEvents) {
                        console.warn(`Extension ${x.id} has no activation events, so it will never be activated.`)
                        return false
                    }
                    const visibleTextDocumentLanguages = nextEnvironment.visibleTextDocuments
                        ? nextEnvironment.visibleTextDocuments.map(({ languageId }) => languageId)
                        : []
                    return x.manifest.activationEvents.some(
                        e => e === '*' || visibleTextDocumentLanguages.some(l => e === `onLanguage:${l}`)
                    )
                } catch (err) {
                    console.error(err)
                }
                return false
            }),
    }
}

declare global {
    interface Window {
        sx: any
        sxenv: any
    }
}

// function foo(
//     extension: Pick<ConfiguredExtension, 'id' | 'manifest'>,
//     settingsCascade: SettingsCascade<any>
// ): Promise<MessageTransports> {
//     if (!extension.manifest) {
//         throw new Error(`unable to run extension ${JSON.stringify(extension.id)}: no manifest found`)
//     }
//     if (isErrorLike(extension.manifest)) {
//         throw new Error(
//             `unable to run extension ${JSON.stringify(extension.id)}: invalid manifest: ${extension.manifest.message}`
//         )
//     }
//
//     if (extension.manifest.url) {
//         try {
//             // TODO!(sqs): move to 1 extension host, many extensions paradigm
//             const worker = new ExtensionHostWorker()
//             const initData: InitData = {
//                 sourcegraphURL: window.context.externalURL,
//                 clientApplication: 'sourcegraph',
//                 settingsCascade,
//             }
//             worker.postMessage(initData)
//             const transports = createWebWorkerMessageTransports(worker)
//
//             ////////////
//             const connection = createConnection(transports)
//             connection.listen()
//             await connection.sendRequest('activateExtension', [extension.manifest.url])
//             ////////////
//
//             return transports
//         } catch (err) {
//             console.error(err)
//         }
//         throw new Error('failed to initialize extension host')
//     }
//     throw new Error(`unable to run extension ${JSON.stringify(extension.id)}: no "url" property in manifest`)
// }

/**
 * Creates the controller, which handles all communication between the client application and
 * extensions.
 *
 * There should only be a single controller for the entire client application. The controller's
 * environment represents all of the client application state that the controller needs to know.
 *
 * It receives state updates via calls to the setEnvironment method. It provides functionality and
 * results via its registries and the showMessages, etc., observables.
 */
export function createController(context: PlatformContext): Controller {
    const controller: Controller = new Controller({
        connectToExtensionHost: () => {
            const { messageTransports, unsubscribe: terminateExecutionContext } = context.createExecutionContext(
                'TODO!(sqs): this is ignored'
            )
            const connection = messageTransports.then(async messageTransports => {
                const connection = createConnection(messageTransports)
                connection.listen()

                // TODO!(sqs): add type for initialize request JSON-RPC 2.0 message
                await connection.sendRequest('initialize', [
                    {
                        clientApplication: 'sourcegraph', // TODO!(sqs): set this differentially based on actual client application
                        sourcegraphURL: 'TODO!(sqs)', // TODO!(sqs): set this differentially based on actual client application
                    } as InitData,
                ])

                return connection
            })
            return {
                ready: connection,
                // activateExtension: bundleURL =>
                //     connection
                //         .then(connection => connection.sendRequest('activateExtension', [bundleURL]))
                //         .then(() => void 0),
                unsubscribe: () => {
                    try {
                        connection.then(connection => connection.unsubscribe()).catch(err => console.error(err))
                    } finally {
                        // Terminate the execution context even if unsubscribing the connection
                        // fails synchronously.
                        terminateExecutionContext()
                    }
                },
            }
        },
        environmentFilter,
    })

    // Apply trace settings.
    //
    // HACK(sqs): This is inefficient and doesn't unsubscribe itself.
    controller.clientEntries.subscribe(entries => {
        const traceEnabled = localStorage.getItem(ExtensionStatus.TRACE_STORAGE_KEY) !== null
        for (const e of entries) {
            e.connection
                .then(c => c.trace(traceEnabled ? Trace.Verbose : Trace.Off, new BrowserConsoleTracer(e.key.id)))
                .catch(err => console.error(err))
        }
    })

    registerBuiltinClientCommands(context, controller)
    registerExtensionContributions(controller)

    // Show messages (that don't need user input) as global notifications.
    controller.showMessages.subscribe(({ message, type }) => controller.notifications.next({ message, type }))

    function messageFromExtension(message: string): string {
        return `From extension:\n\n${message}`
    }
    controller.showMessageRequests.subscribe(({ message, actions, resolve }) => {
        if (!actions || actions.length === 0) {
            alert(messageFromExtension(message))
            resolve(null)
            return
        }
        const value = prompt(
            messageFromExtension(
                `${message}\n\nValid responses: ${actions.map(({ title }) => JSON.stringify(title)).join(', ')}`
            ),
            actions[0].title
        )
        resolve(actions.find(a => a.title === value) || null)
    })
    controller.showInputs.subscribe(({ message, defaultValue, resolve }) =>
        resolve(prompt(messageFromExtension(message), defaultValue))
    )
    controller.configurationUpdates
        .pipe(
            mergeMap(params => {
                const update = updateConfiguration(context, params)
                params.resolve(update)
                return from(update)
            })
        )
        .subscribe(undefined, err => console.error(err))

    // Print window/logMessage log messages to the browser devtools console.
    controller.logMessages.subscribe(({ message }) => {
        log('info', 'EXT', message)
    })

    // Debug helpers.
    const DEBUG = true
    if (DEBUG) {
        // Debug helper: log environment changes.
        const LOG_ENVIRONMENT = false
        if (LOG_ENVIRONMENT) {
            controller.environment.subscribe(environment => log('info', 'env', environment))
        }

        // Debug helpers: e.g., just run `sx` in devtools to get a reference to this controller. (If multiple
        // controllers are created, this points to the last one created.)
        window.sx = controller
        // This value is synchronously available because observable has an underlying
        // BehaviorSubject source.
        controller.environment.subscribe(v => (window.sxenv = v))
    }

    return controller
}

/**
 * Registers the builtin client commands that are required by Sourcegraph extensions. See
 * {@link module:sourcegraph.module/protocol/contribution.ActionContribution#command} for
 * documentation.
 */
function registerExtensionContributions(controller: Controller): Unsubscribable {
    const contributions = controller.environment.pipe(
        map(({ extensions }) => extensions),
        filter((extensions): extensions is ConfiguredExtension[] => !!extensions),
        map(extensions =>
            extensions
                .map(({ manifest }) => manifest)
                .filter((manifest): manifest is ExtensionManifest => manifest !== null && !isErrorLike(manifest))
                .map(({ contributes }) => contributes)
                .filter((contributions): contributions is Contributions => !!contributions)
        )
    )
    return controller.registries.contribution.registerContributions({
        contributions,
    })
}

/** Prints a nicely formatted console log or error message. */
function log(level: 'info' | 'error', subject: string, message: any, other?: { [name: string]: any }): void {
    let f: typeof console.log
    let color: string
    let backgroundColor: string
    if (level === 'info') {
        f = console.log
        color = '#000'
        backgroundColor = '#eee'
    } else {
        f = console.error
        color = 'white'
        backgroundColor = 'red'
    }
    f(
        '%c EXT %s %c',
        `font-weight:bold;background-color:${backgroundColor};color:${color}`,
        subject,
        'font-weight:normal;background-color:unset',
        message,
        other || ''
    )
}
