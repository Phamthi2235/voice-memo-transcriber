const apiKeyInput = document.getElementById("apiKey");
const saveBtn = document.getElementById("save");
const savedMsg = document.getElementById("saved");
const statusDiv = document.getElementById("status");
const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");

function setStatus(hasKey) {
  if (hasKey) {
    statusDiv.className = "status ok";
    dot.className = "dot green";
    statusText.textContent = "API key active — ready to transcribe!";
  } else {
    statusDiv.className = "status missing";
    dot.className = "dot orange";
    statusText.textContent = "No API key set";
  }
}

// Load existing key
chrome.storage.local.get("groqApiKey", (data) => {
  if (data.groqApiKey) {
    apiKeyInput.value = data.groqApiKey;
    setStatus(true);
  }
});

// Save key
saveBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    apiKeyInput.style.borderColor = "#ef4444";
    return;
  }
  chrome.storage.local.set({ groqApiKey: key }, () => {
    setStatus(true);
    savedMsg.classList.add("show");
    apiKeyInput.style.borderColor = "#4ade80";
    setTimeout(() => {
      savedMsg.classList.remove("show");
      apiKeyInput.style.borderColor = "#333";
    }, 2000);
  });
});

// Enter key to save
apiKeyInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveBtn.click();
});
