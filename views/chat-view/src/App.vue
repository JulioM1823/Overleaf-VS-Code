<script setup lang="ts">
    import * as ui from "@vscode/webview-ui-toolkit";
    ui.provideVSCodeDesignSystem().register(ui.allComponents);

    import { ref, onMounted, provide, watchEffect } from "vue";
    import { signalChatReady, MessageStore, type Message } from "./utils";
    import InputBox from "./components/InputBox.vue";
    import MessageList from "./components/MessageList.vue";
    import NewMessageNotice from "./components/NewMessageNotice.vue";

    const unreadRecord = ref<string[]>([]);
    const activeInputBox = ref();
    provide('activeInputBox', activeInputBox);
    provide('unreadRecord', unreadRecord);

    const messageList = ref();
    const inputBox = ref();
    const messages = ref<Message[]>([]);
    const userId = ref('');
    const messageStore = new MessageStore(messages, unreadRecord);

    onMounted(() => {
        window.addEventListener('message', (event) => {
            const data = event.data;
            switch (data.type) {
                case 'get-messages':
                    userId.value = data.userId ?? '';
                    messageStore.userId = data.userId ?? '';
                    messageStore.replace(data.content ?? []);
                    break;
                case 'new-message':
                    messageStore.pushMessage(data.content, true);
                    break;
                case 'insert-text':
                    activeInputBox.value.value.insertText(data.content);
                    break;
                case 'focus-root-input':
                    inputBox.value?.focusInput();
                    break;
                default:
                    break;
            }
        });

        watchEffect(() => {
            if (activeInputBox.value===undefined || activeInputBox.value.value===undefined) {
                activeInputBox.value = inputBox;
            }
        });

        signalChatReady();
    });

    function clickCallback(messageId: string) {
        messageList.value?.scrollItemIntoView(messageId);
    }
</script>

<template>
    <main>
        <MessageList ref="messageList" :messages="messages" :userId="userId" />
        <NewMessageNotice :callback="clickCallback" />
        <InputBox ref="inputBox" mode="compose" />
    </main>
</template>

<style src="@vscode/codicons/dist/codicon.css"></style>
<style>
    html,body,#app {
        height: 100%;
    }

    main {
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        align-items: flex-end;
        height: 100%;
        overflow: auto;
    }
</style>
