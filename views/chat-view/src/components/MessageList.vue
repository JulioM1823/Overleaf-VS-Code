<script setup lang="ts">
    import { ref, watchEffect, type Ref } from 'vue';
    import { type Message } from '../utils';
    import MessageItem from './MessageItem.vue';

    const props = defineProps<{
        messages: Message[],
        userId: string,
    }>();

    const messageContainer = ref<HTMLDivElement>();
    const refs: {[id:string]:any} = ref({});
    const messageRecord: Ref<{[index:number]:string}> = ref({});

    const now = ref(Date.now());
    setInterval(() => {
        now.value = Date.now();
    }, 10 * 1000);

    watchEffect(() => {
        if (messageContainer.value) {
            messageContainer.value.scrollTop = messageContainer.value.scrollHeight;
        }
    });

    function navigate(goUp: boolean) {
        const sortedMessageRecord = Object.entries(messageRecord.value)
            .sort((left, right) => Number(left[0]) - Number(right[0]));
        const messageList = sortedMessageRecord.map((item) => item[1]);

        let focusedMessageIndex = messageList.findIndex((messageId) => (refs.value)[messageId].isFocused);
        focusedMessageIndex = focusedMessageIndex >= 0 ? focusedMessageIndex : messageList.length - 1;

        let nextMessageIndex = goUp ? focusedMessageIndex - 1 : focusedMessageIndex + 1;
        nextMessageIndex = nextMessageIndex < 0 ? 0 : nextMessageIndex;
        nextMessageIndex = nextMessageIndex >= messageList.length ? messageList.length - 1 : nextMessageIndex;

        const nextMessageId = messageList[nextMessageIndex];
        (refs.value)[ nextMessageId ].focus();
    }

    const scrollItemIntoView = (messageId: string) => {
        (refs.value)[ messageId ].scrollIntoView();
    };

    defineExpose({
        scrollItemIntoView,
    });
</script>

<template>
    <div v-if="messages.length === 0" role="list" class="empty-container">
        <span>No messages yet</span>
    </div>
    <div
        v-else
        ref="messageContainer"
        role="list"
        class="message-container"
        @keyup.up="navigate(true)"
        @keyup.down="navigate(false)"
    >
        <template v-for="(message,index) in messages" :key="message.id">
            <vscode-divider role="separator"></vscode-divider>
            <MessageItem
                :ref="(el) => {refs[message.id] = el; messageRecord[index * 100] = message.id;}"
                :aria-posinset="index + 1"
                :aria-setsize="messages.length"
                :message="message"
                :now="now"
                :userId="props.userId"
            />
        </template>
    </div>
</template>

<style scoped>
    .empty-container, .message-container {
        width: 100%;
        margin-bottom: 10px;
    }

    .empty-container {
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        height: 100%;
        color: var(--vscode-descriptionForeground);
    }

    .message-container {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        overflow-y: auto;
        overflow-x: hidden;
    }

    .message-container::-webkit-scrollbar-thumb {
        border-left: 4px solid transparent;
        background-clip: padding-box;
    }
</style>
