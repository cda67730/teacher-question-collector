// 部署 Apps Script 網頁應用程式後，把網址貼在這裡（以 /exec 結尾）
window.APP_CONFIG = {
  GAS_URL: "https://script.google.com/macros/s/AKfycbwxPzGS2lw3yJwvwBXq8bQ2gfHgs3qxFhFUYwR_k4s4PMGdfHW16CRZ2x39rtYnZr-s/exec",
  MAX_RECORD_SECONDS: 180,
  QUESTIONS: [
    {
      id: "Q1",
      text: "最近在班上，哪一個孩子的行為或情緒狀況最讓你困擾？",
      hint: "請描述發生了什麼、大概在什麼時候發生、你當時怎麼處理。"
    },
    {
      id: "Q2",
      text: "和家長溝通時，你遇過什麼困難？",
      hint: "例如不知道怎麼開口、家長的反應、雙方看法不同等。"
    },
    {
      id: "Q3",
      text: "帶班時，你自己最希望得到什麼樣的支持？",
      hint: "可以是方法、資源、人力，或是心情上的支持。"
    }
  ],
  CITIES: ["臺北市","新北市","桃園市","臺中市","臺南市","高雄市","基隆市","新竹市","嘉義市","新竹縣","苗栗縣","彰化縣","南投縣","雲林縣","嘉義縣","屏東縣","宜蘭縣","花蓮縣","臺東縣","澎湖縣","金門縣","連江縣"]
};
