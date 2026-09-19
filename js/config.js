window.INVESTIGATION_BOARD_CONFIG = {
  mode: "supabase",
  boardId: "three-player-investigation-board-v1",

  localPreview: {
    allowFirstRunAdminSetup: false,
  },

  supabase: {
    enabled: true,
    url: "https://mhejtbvicvetcrqipbex.supabase.co",
    publishableKey: "sb_publishable_wiFdejKrpNPhWio2i6lPlA_1BhtRRoh",
    edgeFunctionName: "clever-api",
    storageBucket: "investigation-board-files",
    realtimeTopicPrefix: "investigation-board",
  },

  initialAccounts: [
    {
      id: "HO1",
      displayName: "HO1",
      role: "participant",
      blocked: false,
    },
    {
      id: "HO2",
      displayName: "HO2",
      role: "participant",
      blocked: false,
    },
    {
      id: "SYSTEAM",
      displayName: "SYSTEAM",
      role: "participant",
      blocked: false,
    },
  ],
};
