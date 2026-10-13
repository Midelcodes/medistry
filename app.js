/**
 * ECHMED MEDICAL CENTRE - INTERACTIVE PORTAL CONTROLLER
 * Handles department filtering, consultation scheduling, emergency dispatch modal,
 * search queries, and animated UI components.
 */

document.addEventListener('DOMContentLoaded', () => {
  initDateInputs();
  initMobileNav();
  initSpecialtyFilter();
  initSpecialtySearch();
  initModals();
  initScrollSpy();
});

// Set minimum date for appointment inputs to today
function initDateInputs() {
  const today = new Date().toISOString().split('T')[0];
  const consultDate = document.getElementById('consult-date');
  const modalDate = document.getElementById('modal-date-input');

  if (consultDate) consultDate.min = today;
  if (modalDate) {
    modalDate.min = today;
    modalDate.value = today;
  }
}

// Mobile Navigation Toggle
function initMobileNav() {
  const toggleBtn = document.getElementById('mobile-menu-toggle');
  const drawer = document.getElementById('mobile-nav-drawer');
  const mobileLinks = document.querySelectorAll('.mobile-link');
  const mobileBookBtn = document.getElementById('mobile-book-btn');

  if (!toggleBtn || !drawer) return;

  toggleBtn.addEventListener('click', () => {
    drawer.classList.toggle('open');
  });

  mobileLinks.forEach(link => {
    link.addEventListener('click', () => {
      drawer.classList.remove('open');
    });
  });

  if (mobileBookBtn) {
    mobileBookBtn.addEventListener('click', () => {
      drawer.classList.remove('open');
      openBookingModal();
    });
  }
}

// Medical Specialties Category Filter Tabs
function initSpecialtyFilter() {
  const filterPills = document.querySelectorAll('.filter-pill');
  const specialtyCards = document.querySelectorAll('.specialty-card');

  filterPills.forEach(pill => {
    pill.addEventListener('click', () => {
      filterPills.forEach(p => {
        p.classList.remove('active');
        p.setAttribute('aria-selected', 'false');
      });
      pill.classList.add('active');
      pill.setAttribute('aria-selected', 'true');

      const filterCategory = pill.getAttribute('data-filter');

      specialtyCards.forEach(card => {
        const cardCategory = card.getAttribute('data-category');
        if (filterCategory === 'all' || cardCategory === filterCategory) {
          card.classList.remove('hidden');
          card.style.animation = 'fadeIn 0.3s ease forwards';
        } else {
          card.classList.add('hidden');
        }
      });
    });
  });
}

// Medical Specialties Search Box
function initSpecialtySearch() {
  const searchInput = document.getElementById('specialty-search-input');
  const searchBtn = document.getElementById('search-action-btn');
  const specialtyCards = document.querySelectorAll('.specialty-card');

  function performSearch() {
    const query = (searchInput.value || '').trim().toLowerCase();
    if (!query) return;

    // Scroll smoothly to specialties section
    const specialtiesSection = document.getElementById('specialties');
    if (specialtiesSection) {
      specialtiesSection.scrollIntoView({ behavior: 'smooth' });
    }

    // Reset filter pills to All
    const allPill = document.querySelector('.filter-pill[data-filter="all"]');
    if (allPill) allPill.click();

    let matchedCount = 0;
    specialtyCards.forEach(card => {
      const text = card.textContent.toLowerCase();
      if (text.includes(query)) {
        card.classList.remove('hidden');
        card.style.borderColor = 'var(--primary-color)';
        matchedCount++;
      } else {
        card.classList.add('hidden');
      }
    });

    if (matchedCount === 0) {
      showToast('Search Result', `No exact department found for "${query}". Showing all departments.`);
      specialtyCards.forEach(card => {
        card.classList.remove('hidden');
        card.style.borderColor = 'rgba(220, 226, 245, 0.8)';
      });
    }
  }

  if (searchBtn && searchInput) {
    searchBtn.addEventListener('click', performSearch);
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') performSearch();
    });
  }
}

// Booking & Emergency Dispatch Modals
function initModals() {
  const bookingModal = document.getElementById('booking-modal');
  const openAppointmentBtn = document.getElementById('open-appointment-btn');
  const heroReadMoreBtn = document.getElementById('hero-read-more-btn');
  const heroContactBtn = document.getElementById('hero-contact-now-btn');
  const modalCloseBtn = document.getElementById('modal-close-btn');
  const modalCancelBtn = document.getElementById('modal-cancel-btn');

  // Emergency Modal elements
  const dispatchModal = document.getElementById('dispatch-modal');
  const dispatchModalBtn = document.getElementById('dispatch-modal-btn');
  const dispatchCloseBtn = document.getElementById('dispatch-close-btn');

  // Toast close
  const toastClose = document.getElementById('toast-close');
  if (toastClose) {
    toastClose.addEventListener('click', () => {
      document.getElementById('toast-notification').classList.remove('show');
    });
  }

  if (openAppointmentBtn) {
    openAppointmentBtn.addEventListener('click', () => openBookingModal());
  }

  if (heroReadMoreBtn) {
    heroReadMoreBtn.addEventListener('click', () => {
      const about = document.getElementById('about');
      if (about) about.scrollIntoView({ behavior: 'smooth' });
    });
  }

  if (heroContactBtn) {
    heroContactBtn.addEventListener('click', () => openBookingModal());
  }

  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', closeBookingModal);
  }

  if (modalCancelBtn) {
    modalCancelBtn.addEventListener('click', closeBookingModal);
  }

  if (dispatchModalBtn) {
    dispatchModalBtn.addEventListener('click', () => {
      if (dispatchModal) dispatchModal.classList.add('open');
    });
  }

  if (dispatchCloseBtn) {
    dispatchCloseBtn.addEventListener('click', () => {
      if (dispatchModal) dispatchModal.classList.remove('open');
    });
  }

  // Virtual Campus Tour Button
  const virtualTourBtn = document.getElementById('virtual-tour-btn');
  if (virtualTourBtn) {
    virtualTourBtn.addEventListener('click', () => {
      showToast('Virtual Tour Initialized', 'Loading 360° interactive bio-architectural pavilion tour...');
    });
  }

  // Close modals on escape key or outside click
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeBookingModal();
      if (dispatchModal) dispatchModal.classList.remove('open');
    }
  });

  window.addEventListener('click', (e) => {
    if (e.target === bookingModal) closeBookingModal();
    if (e.target === dispatchModal) dispatchModal.classList.remove('open');
  });
}

// Open Booking Modal with optional pre-selection
window.openBookingModal = function(department = 'Cardiology', doctor = '') {
  const modal = document.getElementById('booking-modal');
  const deptSelect = document.getElementById('modal-dept-select');
  const previewName = document.getElementById('preview-doc-name');
  const previewMeta = document.getElementById('preview-doc-meta');

  if (deptSelect && department) {
    deptSelect.value = department;
  }

  if (doctor) {
    previewName.textContent = `Specialist: ${doctor}`;
    previewMeta.textContent = `Department of ${department} • Priority slot reserved`;
  } else {
    previewName.textContent = `Selected Department: ${department}`;
    previewMeta.textContent = `Next available consultation slot: Today`;
  }

  if (modal) {
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
  }
};

function closeBookingModal() {
  const modal = document.getElementById('booking-modal');
  if (modal) {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }
}

// Submit Modal Booking Form
window.submitModalBooking = function() {
  const patientName = document.getElementById('modal-patient-name').value;
  const dept = document.getElementById('modal-dept-select').value;
  const date = document.getElementById('modal-date-input').value;
  const time = document.getElementById('modal-time-select').value;

  closeBookingModal();

  showToast(
    'Consultation Confirmed', 
    `Thank you, ${patientName}! Your appointment in ${dept} on ${date} at ${time} is registered.`
  );
};

// Submit Quick Consultation Request (Page Form)
window.submitConsultation = function() {
  const name = document.getElementById('patient-name').value;
  const dept = document.getElementById('consult-dept').value;

  showToast(
    'Request Received', 
    `Thank you, ${name}. Our medical coordinator will call you to confirm your ${dept} appointment.`
  );

  document.getElementById('quick-consult-form').reset();
};

// Newsletter Subscription
window.subscribeNewsletter = function() {
  const emailInput = document.getElementById('newsletter-email');
  if (emailInput && emailInput.value) {
    showToast('Subscribed Successfully', `Monthly medical bulletins will be sent to ${emailInput.value}.`);
    emailInput.value = '';
  }
};

// Toast Notification Helper
function showToast(title, message) {
  const toast = document.getElementById('toast-notification');
  const toastTitle = document.getElementById('toast-title');
  const toastMessage = document.getElementById('toast-message');

  if (!toast) return;

  toastTitle.textContent = title;
  toastMessage.textContent = message;

  toast.classList.add('show');

  setTimeout(() => {
    toast.classList.remove('show');
  }, 5000);
}

// Active Nav Link Scrollspy
function initScrollSpy() {
  const sections = document.querySelectorAll('section[id]');
  const navLinks = document.querySelectorAll('.nav-links-pill .nav-link');

  window.addEventListener('scroll', () => {
    let current = '';
    const scrollPosition = window.pageYOffset + 120;

    sections.forEach(section => {
      const sectionTop = section.offsetTop;
      const sectionHeight = section.offsetHeight;
      if (scrollPosition >= sectionTop && scrollPosition < sectionTop + sectionHeight) {
        current = section.getAttribute('id');
      }
    });

    navLinks.forEach(link => {
      link.classList.remove('active');
      if (link.getAttribute('href') === `#${current}`) {
        link.classList.add('active');
      }
    });
  });
}

