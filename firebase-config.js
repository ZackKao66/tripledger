// 旅帳 PWA — Firebase 連線設定（公開識別資訊，非密碼）
export const firebaseConfig = {
  apiKey: "AIzaSyDjZ_Memp-yC8LRuGyOkpDlwrqfswqDmik",
  authDomain: "travel-expense-app-fbde7.firebaseapp.com",
  projectId: "travel-expense-app-fbde7",
  storageBucket: "travel-expense-app-fbde7.firebasestorage.app",
  messagingSenderId: "316471344576",
  appId: "1:316471344576:web:81e508628cdc4a110bdc25"
};

// 推播通知設定（Cloudflare Worker）
export const pushConfig = {
  url: "https://tripledger-push.kao820606.workers.dev",
  vapidPublicKey: "BJnCq4_NpkESaIxVnX4tvBFGHRnGE1n0Q4XMtnQCfT1IFcRC4WDZVJkq49-nXkNleE_xMIUgFdoXTOWAK23nSNs"
};
