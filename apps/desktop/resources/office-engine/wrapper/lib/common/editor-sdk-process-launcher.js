"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nodeEditorSdkProcessLauncher = exports.NodeEditorSdkProcessLauncher = void 0;
const node_child_process_1 = require("node:child_process");
function asManagedProcess(child) {
    return Object.assign(child, {
        requestStop: () => child.kill('SIGTERM'),
        forceStop: () => child.kill('SIGKILL'),
    });
}
/** Default compatibility launcher used when a host does not inject one. */
class NodeEditorSdkProcessLauncher {
    launch(request) {
        const child = (0, node_child_process_1.spawn)(request.binaryPath, [...request.args], {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
            cwd: request.cwd,
        });
        return asManagedProcess(child);
    }
}
exports.NodeEditorSdkProcessLauncher = NodeEditorSdkProcessLauncher;
exports.nodeEditorSdkProcessLauncher = new NodeEditorSdkProcessLauncher();
//# sourceMappingURL=editor-sdk-process-launcher.js.map