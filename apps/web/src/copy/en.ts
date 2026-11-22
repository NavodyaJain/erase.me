/**
 * Every user-facing string in the app (English first, so the app is ready for other languages). Wording follows
 * PRD 4.4: hedged ("likely holds", "may hold", "looks unused"), no promise about what a company will do, and no
 * deletion promise for a must-keep company. A test checks this module and the rendered screens against the
 * banned words, so keep new strings here rather than inline in components.
 */
export const copy = {
  brand: { name: 'Erase.me' },

  nav: {
    overview: 'Overview',
    requests: 'Requests',
    inboxes: 'Inboxes',
    main: 'Main',
    skip: 'Skip to content',
  },

  common: {
    loading: 'Loading',
    retry: 'Try again',
    cancel: 'Cancel',
    close: 'Close',
    save: 'Save',
    saving: 'Saving',
    back: 'Back',
    signOut: 'Sign out',
    sampleData: 'Sample data',
  },

  pwa: {
    updateTitle: 'Update available',
    updateBody: 'A new version of Erase.me is ready.',
    updateAction: 'Update now',
    installTitle: 'Add Erase.me to your home screen',
    installBody: 'Tap Share, then Add to Home Screen.',
    dismiss: 'Got it',
  },

  offline: {
    title: 'You are offline',
    body: 'Erase.me needs a connection to show your companies and requests. Reconnect and try again.',
    note: 'Erase.me does not keep your companies or requests on this device.',
    retry: 'Try again',
  },

  labels: {
    confidence: { high: 'Likely', low: 'Possible' },
    confidenceHelp: {
      high: 'Messages from this company suggest it likely holds data about you.',
      low: 'Messages from this company suggest it may hold data about you.',
    },
    activity: { looks_in_use: 'Looks in use', looks_unused: 'Looks unused' },
    activityHelp: {
      looks_in_use: 'A receipt or similar message arrived recently. This is a hint, not a decision.',
      looks_unused: 'Nothing has arrived from this company for a long time. This is a hint, not a decision.',
    },
    signals: {
      welcome: 'Welcome email',
      receipt: 'Receipt or invoice',
      verify: 'Account verification',
      transactional: 'Order, booking or statement mail',
      list_unsubscribe: 'Mailing list',
      newsletter: 'Newsletter',
    },
    requestStatus: {
      drafted: 'Drafted',
      approved: 'Approved',
      sent: 'Sent',
      replied_deleted: 'Replied',
      replied_info_requested: 'Replied',
      replied_refused: 'Replied',
      no_reply: 'No reply yet',
      closed: 'Closed',
      bounced: 'Did not arrive',
    },
    event: {
      drafted: 'Draft made',
      edited: 'Draft edited',
      approved: 'You approved it',
      sent: 'Sent',
      closed: 'Closed',
      bounced: 'Did not arrive',
      reply_label: 'Reply recorded',
    },
    scanStatus: { queued: 'Waiting to scan', running: 'Scanning', done: 'Scan finished', failed: 'Scan did not finish' },
    inboxStatus: { connected: 'Connected', disconnected: 'Disconnected', error: 'Needs reconnecting' },
    category: {
      loan_app: 'Loan app',
      wallet_payments: 'Wallet or payments',
      broker_investing: 'Investing',
      credit: 'Credit',
      ecommerce: 'Shopping',
      travel: 'Travel',
      streaming: 'Streaming',
      education: 'Education',
      social: 'Social',
      saas: 'Software',
      other: 'Other',
    },
  },
} as const;
