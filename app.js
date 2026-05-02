// Firebase Configuration
const firebaseConfig = {
  apiKey: "AIzaSyBeUGm4gKbYE3zlgmYEPza8yy1xB4xBSlU",
  authDomain: "rank-app-34ab8.firebaseapp.com",
  projectId: "rank-app-34ab8",
  storageBucket: "rank-app-34ab8.firebasestorage.app",
  messagingSenderId: "204472306082",
  appId: "1:204472306082:web:711cfdcd6e0e1b02de4afb",
  measurementId: "G-QLNF850ZW1"
};

// Firebase modular SDK imports from CDN
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { 
  getFirestore, 
  serverTimestamp,
  collection,
  addDoc,
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  query,
  orderBy
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-analytics.js";

// Initialize Firebase
let db;
let rankingsUnsubscribe;

function initFirebase() {
  try {
    const app = initializeApp(firebaseConfig);
    const analytics = getAnalytics(app);
    db = getFirestore(app);
    return true;
  } catch (err) {
    console.error('Firebase initialization error:', err);
    showOfflineMessage();
    return false;
  }
}

// DOM Elements
const form = document.getElementById('submit-form');
const nameInput = document.getElementById('name-input');
const errorMessage = document.getElementById('error-message');
const rankingsList = document.getElementById('rankings-list');
const emptyState = document.getElementById('empty-state');
const offlineMessage = document.getElementById('offline-message');

// State
let rankings = [];
let pendingUpvoteId = null;
let pendingUpvoteOldVotes = null;
let inFlightUpvotes = new Set();

// Show error message
function showError(message) {
  errorMessage.textContent = message;
  setTimeout(() => {
    errorMessage.textContent = '';
  }, 3000);
}

// Show offline message
function showOfflineMessage() {
  offlineMessage.classList.add('visible');
}

// Hide offline message
function hideOfflineMessage() {
  offlineMessage.classList.remove('visible');
}

// Clear input
function clearInput() {
  nameInput.value = '';
  nameInput.focus();
}

// Toggle empty state
function toggleEmptyState() {
  const isEmpty = rankings.length === 0;
  emptyState.classList.toggle('hidden', !isEmpty);
  rankingsList.classList.toggle('hidden', isEmpty);
}

// Sort rankings by votes (descending)
function sortRankings() {
  rankings.sort((a, b) => b.votes - a.votes);
}

// Render rankings
function renderRankings() {
  sortRankings();
  
  rankingsList.innerHTML = '';
  
  rankings.forEach((entry, index) => {
    const rankNumber = index + 1;
    const card = document.createElement('div');
    card.className = 'ranking-entry';
    card.dataset.id = entry.id;
    
    const isUpvoted = hasUpvoted(entry.id);
    
    card.innerHTML = `
      <div class="rank-number">${rankNumber}</div>
      <div class="entry-name">${escapeHtml(entry.name)}</div>
      <button class="upvote-btn${isUpvoted ? ' upvoted' : ''}" data-id="${entry.id}"${isUpvoted ? ' disabled' : ''}>
        <span class="upvote-icon">▲</span>
        <span class="vote-count">${entry.votes}</span>
      </button>
    `;
    
    rankingsList.appendChild(card);
  });
  
  toggleEmptyState();
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Check for duplicate name
function isDuplicateName(name) {
  const normalizedName = name.toLowerCase().trim();
  return rankings.some(entry => entry.name.toLowerCase().trim() === normalizedName);
}

// Add new name
async function addName(name) {
  const trimmedName = name.trim();
  
  if (!trimmedName) {
    showError('Please enter a name');
    return false;
  }
  
  if (isDuplicateName(trimmedName)) {
    showError('This name already exists in the ranking');
    return false;
  }
  
  try {
    await addDoc(collection(db, 'rankings'), {
      name: trimmedName,
      votes: 0,
      createdAt: serverTimestamp()
    });
    
    clearInput();
    return true;
  } catch (err) {
    console.error('Error adding name:', err);
    showError('Failed to add name. Please try again.');
    return false;
  }
}

// LocalStorage helpers for tracking upvotes
function getUpvotedIds() {
  try {
    return JSON.parse(localStorage.getItem('upvotedIds')) || [];
  } catch {
    return [];
  }
}

function hasUpvoted(id) {
  return getUpvotedIds().includes(id);
}

function saveUpvoted(id) {
  const ids = getUpvotedIds();
  if (!ids.includes(id)) {
    ids.push(id);
    localStorage.setItem('upvotedIds', JSON.stringify(ids));
  }
}
async function upvote(id) {
  // Prevent double-clicks during in-flight request
  if (inFlightUpvotes.has(id)) {
    return false;
  }
  if (hasUpvoted(id)) {
    showError('You have already upvoted this entry');
    return false;
  }

  const btn = document.querySelector(`.upvote-btn[data-id="${id}"]`);
  const countSpan = btn?.querySelector('.vote-count');
  const previousVotes = countSpan ? parseInt(countSpan.textContent) : 0;
  
  // Optimistic update - just update the button text immediately
  if (countSpan) {
    countSpan.textContent = previousVotes + 1;
  }
  if (btn) {
    btn.classList.add('pulse');
    setTimeout(() => btn.classList.remove('pulse'), 300);
  }
  
  // Track pending upvote to skip only that specific change
  const entry = rankings.find(r => r.id === id);
  pendingUpvoteId = id;
  pendingUpvoteOldVotes = entry ? entry.votes : 0;
  inFlightUpvotes.add(id);
  
  try {
    const docRef = doc(db, 'rankings', id);
    
    await runTransaction(db, async (transaction) => {
      const docSnap = await getDoc(docRef);
      
      if (!docSnap.exists()) {
        throw new Error('Document does not exist');
      }
      
      const currentVotes = docSnap.data().votes || 0;
      transaction.update(docRef, { votes: currentVotes + 1 });
    });
    
    // Save upvote and disable button
    saveUpvoted(id);
    if (btn) {
      btn.disabled = true;
      btn.classList.add('upvoted');
    }
    inFlightUpvotes.delete(id);
    
    return true;
  } catch (err) {
    console.error('Error upvoting:', err);
    
    // Rollback on failure
    if (countSpan) {
      countSpan.textContent = previousVotes;
    }
    inFlightUpvotes.delete(id);
    
    showError('Failed to upvote. Please try again.');
    inFlightUpvotes.delete(id);
    return false;
  }
}

// Check if rankings data has changed
function rankingsDataChanged(newRankings) {
  // If we have a pending upvote, only skip if change is exactly that entry's vote +1
  if (pendingUpvoteId) {
    const oldEntry = rankings.find(r => r.id === pendingUpvoteId);
    const newEntry = newRankings.find(r => r.id === pendingUpvoteId);
    if (oldEntry && newEntry && newEntry.votes === pendingUpvoteOldVotes + 1) {
      // Skip this render - it's just our optimistic update coming back
      pendingUpvoteId = null;
      pendingUpvoteOldVotes = null;
      return false;
    }
  }
  
  if (newRankings.length !== rankings.length) return true;
  for (let i = 0; i < newRankings.length; i++) {
    if (newRankings[i].id !== rankings[i].id || newRankings[i].votes !== rankings[i].votes) {
      return true;
    }
  }
  return false;
}

// Subscribe to rankings changes
function subscribeToRankings() {
  if (rankingsUnsubscribe) {
    rankingsUnsubscribe();
  }
  
  const q = query(
    collection(db, 'rankings'),
    orderBy('votes', 'desc')
  );
  
  rankingsUnsubscribe = onSnapshot(
    q,
    (snapshot) => {
      hideOfflineMessage();
      
      const newRankings = [];
      snapshot.forEach((doc) => {
        newRankings.push({
          id: doc.id,
          ...doc.data()
        });
      });
      
      // Only re-render if data actually changed
      if (rankingsDataChanged(newRankings)) {
        rankings = newRankings;
        renderRankings();
      }
    },
    (err) => {
      console.error('Firestore subscription error:', err);
      showOfflineMessage();
    }
  );
}

// Event Listeners
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = nameInput.value;
  
  if (name) {
    await addName(name);
  }
});

rankingsList.addEventListener('click', async (e) => {
  const upvoteBtn = e.target.closest('.upvote-btn');
  
  if (upvoteBtn) {
    const id = upvoteBtn.dataset.id;
    await upvote(id);
  }
});

// Handle online/offline status
window.addEventListener('online', hideOfflineMessage);
window.addEventListener('offline', showOfflineMessage);

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  if (initFirebase()) {
    subscribeToRankings();
  }
});
