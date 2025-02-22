import { Dictionary, PayloadAction, createSlice } from "@reduxjs/toolkit";
import { GetUnreadCountResponse, PrivateMessageView } from "lemmy-js-client";
import { AppDispatch, RootState } from "../../store";
import { clientSelector, jwtSelector } from "../auth/authSlice";
import { InboxItemView } from "./InboxItem";
import { differenceBy, uniqBy } from "lodash";
import { receivedUsers } from "../user/userSlice";

interface PostState {
  counts: {
    mentions: number;
    messages: number;
    replies: number;
  };
  lastUpdatedCounts: number;
  readByInboxItemId: Dictionary<boolean>;
  messageSyncState: "init" | "syncing" | "synced";
  messages: PrivateMessageView[];
}

const initialState: PostState = {
  counts: {
    mentions: 0,
    messages: 0,
    replies: 0,
  },
  lastUpdatedCounts: 0,
  readByInboxItemId: {},
  messageSyncState: "init",
  messages: [],
};

export const inboxSlice = createSlice({
  name: "inbox",
  initialState,
  reducers: {
    receivedInboxCounts: (
      state,
      action: PayloadAction<GetUnreadCountResponse>
    ) => {
      state.counts.mentions = action.payload.mentions;
      state.counts.messages = action.payload.private_messages;
      state.counts.replies = action.payload.replies;
      state.lastUpdatedCounts = Date.now();
    },
    receivedInboxItems: (state, action: PayloadAction<InboxItemView[]>) => {
      for (const item of action.payload) {
        state.readByInboxItemId[getInboxItemId(item)] =
          getInboxItemReadStatus(item);
      }
    },
    setReadStatus: (
      state,
      action: PayloadAction<{ item: InboxItemView; read: boolean }>
    ) => {
      state.readByInboxItemId[getInboxItemId(action.payload.item)] =
        action.payload.read;
    },
    receivedMessages: (state, action: PayloadAction<PrivateMessageView[]>) => {
      state.messages = uniqBy(
        [...action.payload, ...state.messages],
        (m) => m.private_message.id
      );
    },
    sync: (state) => {
      state.messageSyncState = "syncing";
    },
    syncComplete: (state) => {
      state.messageSyncState = "synced";
    },
    syncFail: (state) => {
      if (state.messageSyncState === "syncing") state.messageSyncState = "init";
    },
    resetInbox: () => initialState,
  },
});

// Action creators are generated for each case reducer function
export const {
  receivedInboxCounts,
  receivedInboxItems,
  setReadStatus,
  receivedMessages,
  resetInbox,

  sync,
  syncComplete,
  syncFail,
} = inboxSlice.actions;

export default inboxSlice.reducer;

export const totalUnreadSelector = (state: RootState) =>
  state.inbox.counts.mentions +
  state.inbox.counts.messages +
  state.inbox.counts.replies;

export const getInboxCounts =
  () => async (dispatch: AppDispatch, getState: () => RootState) => {
    const jwt = jwtSelector(getState());

    if (!jwt) {
      dispatch(resetInbox());
      return;
    }

    const lastUpdatedCounts = getState().inbox.lastUpdatedCounts;

    if (Date.now() - lastUpdatedCounts < 3_000) return;

    const result = await clientSelector(getState()).getUnreadCount({
      auth: jwt,
    });

    if (result) dispatch(receivedInboxCounts(result));
  };

export const syncMessages =
  () => async (dispatch: AppDispatch, getState: () => RootState) => {
    const jwt = jwtSelector(getState());

    if (!jwt) {
      dispatch(resetInbox());
      return;
    }

    const syncState = getState().inbox.messageSyncState;

    switch (syncState) {
      case "syncing":
        break;
      case "init":
      case "synced": {
        dispatch(sync());

        let page = 1;

        while (true) {
          let privateMessages;

          try {
            const results = await clientSelector(getState()).getPrivateMessages(
              {
                auth: jwt,
                limit: syncState === "init" ? 50 : page === 1 ? 1 : 20,
                page,
              }
            );
            privateMessages = results.private_messages;
          } catch (e) {
            dispatch(syncFail());
            throw e;
          }

          const newMessages = differenceBy(
            privateMessages,
            getState().inbox.messages,
            (msg) => msg.private_message.id
          );

          dispatch(receivedMessages(privateMessages));
          dispatch(receivedUsers(privateMessages.map((msg) => msg.creator)));
          dispatch(receivedUsers(privateMessages.map((msg) => msg.recipient)));

          if (!newMessages.length || page > 10) break;
          page++;
        }

        dispatch(syncComplete());
      }
    }
  };

export const markAllRead =
  () => async (dispatch: AppDispatch, getState: () => RootState) => {
    const jwt = jwtSelector(getState());

    if (!jwt) return;

    await clientSelector(getState()).markAllAsRead({ auth: jwt });

    dispatch(getInboxCounts());
  };

export function getInboxItemId(item: InboxItemView): string {
  if ("comment_reply" in item) {
    return `repl_${item.comment_reply.id}`;
  }

  if ("private_message" in item) {
    return `dm_${item.private_message.id}`;
  }

  return `mention_${item.person_mention.id}`;
}

export function getInboxItemReadStatus(item: InboxItemView): boolean {
  if ("comment_reply" in item) {
    return item.comment_reply.read;
  }

  if ("private_message" in item) {
    return item.private_message.read;
  }

  return item.person_mention.read;
}

export function getInboxItemPublished(item: InboxItemView): string {
  if ("comment_reply" in item) {
    return item.comment_reply.published;
  }

  if ("private_message" in item) {
    return item.private_message.published;
  }

  return item.person_mention.published;
}

export const markRead =
  (item: InboxItemView, read: boolean) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    const jwt = jwtSelector(getState());
    const client = clientSelector(getState());

    if (!jwt) throw new Error("needs auth");

    const initialRead =
      !!getState().inbox.readByInboxItemId[getInboxItemId(item)];

    dispatch(setReadStatus({ item, read }));

    try {
      if ("person_mention" in item) {
        await client.markPersonMentionAsRead({
          read,
          person_mention_id: item.person_mention.id,
          auth: jwt,
        });
      } else if ("comment_reply" in item) {
        await client.markCommentReplyAsRead({
          read,
          comment_reply_id: item.comment_reply.id,
          auth: jwt,
        });
      } else if ("private_message" in item) {
        await client.markPrivateMessageAsRead({
          read,
          private_message_id: item.private_message.id,
          auth: jwt,
        });
      }
    } catch (error) {
      dispatch(setReadStatus({ item, read: initialRead }));

      throw error;
    }

    dispatch(getInboxCounts());
  };
