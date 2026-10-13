# MEDISTRY Regulatory & Privacy Compliance Mapping (NDPA 2023 / MDCN)

> [!CAUTION]
> **Legal Disclaimer**: This document serves as a technical engineering mapping of system features to the provisions of the **Nigeria Data Protection Act (NDPA) 2023** and **Medical and Dental Council of Nigeria (MDCN)** guidelines. This document **does not** constitute formal legal advice or clinical validation. Independent review by qualified healthcare legal counsel and certified data protection officers is strictly required prior to commercial clinical deployment.

---

## 1. Statutory Context & Principles

MEDISTRY operates as a Data Controller and Processor under the provisions of the **Nigeria Data Protection Act (NDPA) 2023**, regulated by the **Nigeria Data Protection Commission (NDPC)**. Health and genetic data are classified as **Sensitive Personal Data** under Section 30 of the Act, demanding heightened technical and organizational safeguards.

---

## 2. Technical Mapping Matrix

| NDPA 2023 Provision | Principle & Requirement | MEDISTRY Technical Implementation |
| :--- | :--- | :--- |
| **Section 24(1)(a)** | Lawfulness, Fairness & Transparency | Consent-first architecture. Patient owns record, determines granular scopes (All vs specific FHIR resources), and specifies access duration (one-time, 7 days, 30 days). |
| **Section 24(1)(b)** | Purpose Limitation | Break-glass emergency access is strictly time-boxed (60 minutes) and restricted to minimal triage data (blood group, genotype, allergies). Full history requires verified dual-clinician co-sign. |
| **Section 24(1)(c)** | Data Minimization | Emergency QR cards and NFC payloads contain zero clinical data—only an opaque, unguessable URL (`/e/<code>`). No personal data is exposed to anonymous scanners. |
| **Section 30(1)** | Processing of Sensitive Personal Data (Health & Genotypes) | Multi-layered field-level encryption (AES-256-GCM) with key rotation. Clinical observations and diagnoses are stored in encrypted FHIR R4 containers. |
| **Section 34** | Rights of the Data Subject (Right to be Informed & Access) | Immutable, patient-facing **"Who accessed my record"** audit trail. Patients receive instant alerts (SMS/push) upon any emergency break-glass event with dispute escalation. |
| **Section 34(1)(d)** | Right to Data Portability | Standards-compliant FHIR R4 JSON export bundle and human-readable patient health summary PDF download. |
| **Section 39** | Security of Processing & Technical Safeguards | Argon2id/scrypt memory-hard password hashing, mandatory RFC 6238 TOTP MFA for clinicians, 15-minute clinician session timeouts, and SHA-256 hash-chained audit trails. |
| **Section 41 & 42** | Cross-Border Data Transfer Restrictions | Single-region in-country data residency (`DEPLOYMENT_COUNTRY=NG`). All primary databases, logs, and cryptographic keys reside in the authorized regional zone. |

---

## 3. Clinician Licensing & Regulatory Oversight (MDCN)

In compliance with the **Medical and Dental Practitioners Act (Cap M8, LFN 2004)**:
1. **Practitioner Folio Validation**: Clinicians must submit valid Folio credentials (`MDCN/R/XXXXX`, `MDCN/P/XXXXX`, `MDCN/F/XXXXX`).
2. **Multi-Tenant Facility Affiliation**: Clinicians must be tied to verified healthcare facilities with verifiable operating permits.
3. **Pluggable MDCN Registry**: Onboarding is governed by the `IMdcnRegistryAdapter` interface, enabling immediate manual registrar vetting and future automated live lookup against the MDCN electronic register.

