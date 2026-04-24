/* eslint-disable @typescript-eslint/naming-convention */
import { vscode } from "./vscode";
import { type Ref } from "vue";

export interface Message {
    id: string,
    content: string,
    edited_at?: number,
    timestamp: number,
    deliveryDetail?: 'queued' | 'sending',
    deliveryState?: 'delivered' | 'pending',
    user_id: string,
    user: {
        id: string,
        first_name: string,
        last_name?: string,
        email: string,
    },
    clientId?: string,
    newMessage?: boolean,
}

export function signalChatReady() {
    vscode.postMessage({
        type: 'chat-ready',
    });
}

export function requestMessages() {
    vscode.postMessage({
        type: 'get-messages',
    });
}

export function sendMessage(content: string) {
    const trimmedContent = content.trim();
    if (!trimmedContent) {
        return false;
    }
    vscode.postMessage({
        type: 'send-message',
        content: trimmedContent,
    });
    return true;
}

export function editMessage(messageId: string, content: string) {
    const trimmedContent = content.trim();
    if (!messageId || !trimmedContent) {
        return false;
    }
    vscode.postMessage({
        type: 'edit-message',
        content: trimmedContent,
        messageId,
    });
    return true;
}

export function deleteMessage(messageId: string) {
    if (!messageId) {
        return false;
    }
    vscode.postMessage({
        type: 'delete-message',
        messageId,
    });
    return true;
}

export class MessageStore {
    userId = '';

    constructor(
        private messages: Ref<Message[]>,
        private unreadRecord: Ref<string[]>,
    ) {}

    replace(messages: Message[]) {
        this.messages.value = messages.map((message) => ({
            ...message,
            newMessage: false,
        }));
        const currentIds = new Set(this.messages.value.map((message) => message.id));
        this.unreadRecord.value = this.unreadRecord.value.filter((messageId) => currentIds.has(messageId));
    }

    pushMessage(message: Message, newMessage = false) {
        const nextMessage = {
            ...message,
            newMessage: false,
        };
        const index = this.messages.value.findIndex((existing) => existing.id===message.id);
        if (index >= 0) {
            this.messages.value[index] = nextMessage;
        } else {
            this.messages.value.push(nextMessage);
        }

        const shouldMarkUnread = newMessage
            && message.user.id !== this.userId
            && !this.unreadRecord.value.includes(message.id);
        if (shouldMarkUnread) {
            nextMessage.newMessage = true;
            this.unreadRecord.value.push(message.id);
        }
    }
}
