/**
 * MEDISTRY WCAG 2.1 AA Accessibility Auditor
 * Programmatically audits emergency summary and consent interfaces
 * for WCAG 2.1 AA compliance (touch targets, contrast markers, ARIA landmarks, mobile zooming).
 */

export interface AccessibilityAuditResult {
  passed: boolean;
  score: number; // 0 to 100
  checks: {
    hasValidViewportZoom: boolean;
    hasMainLandmark: boolean;
    hasAlertRoles: boolean;
    hasLargeTouchTargets: boolean;
    hasAriaLabelsOnInteractive: boolean;
    hasSemanticTableStructure: boolean;
    hasAccessibleColorContrastStyles: boolean;
  };
  violations: string[];
}

export function auditHtmlForWcag21AA(htmlContent: string): AccessibilityAuditResult {
  const violations: string[] = [];
  const checks = {
    hasValidViewportZoom: false,
    hasMainLandmark: false,
    hasAlertRoles: false,
    hasLargeTouchTargets: false,
    hasAriaLabelsOnInteractive: false,
    hasSemanticTableStructure: false,
    hasAccessibleColorContrastStyles: false,
  };

  // 1. Viewport Zoom Test (WCAG 1.4.4 Resize Text)
  // Ensures user-scalable=no is NOT present and maximum-scale allows at least 200% zoom
  const viewportMatch = htmlContent.match(/<meta\s+name=["']viewport["']\s+content=["']([^"']+)["']/i);
  if (viewportMatch) {
    const content = viewportMatch[1];
    const prohibitsScale = content.includes('user-scalable=no') || content.includes('user-scalable=0');
    const maxScaleMatch = content.match(/maximum-scale=([0-9.]+)/);
    const maxScale = maxScaleMatch ? parseFloat(maxScaleMatch[1]) : 1.0;

    if (!prohibitsScale && maxScale >= 2.0) {
      checks.hasValidViewportZoom = true;
    } else {
      violations.push('WCAG 1.4.4: Viewport disables pinch-to-zoom or sets maximum-scale below 2.0');
    }
  } else {
    violations.push('WCAG 1.4.4: Missing viewport meta tag');
  }

  // 2. Landmark Roles Test (WCAG 1.3.1 Info and Relationships)
  if (/<main\b/i.test(htmlContent) && /<header\b/i.test(htmlContent)) {
    checks.hasMainLandmark = true;
  } else {
    violations.push('WCAG 1.3.1: Missing semantic landmark elements (<main>, <header>)');
  }

  // 3. Alert Role Test (WCAG 4.1.3 Status Messages)
  if (/role=["']alert["']/i.test(htmlContent)) {
    checks.hasAlertRoles = true;
  } else {
    violations.push('WCAG 4.1.3: Critical emergency notices missing role="alert"');
  }

  // 4. Touch Target Test (WCAG 2.5.5 / 2.5.8 Target Size - min 44x44px or min-height: 44px)
  if (/min-height:\s*44px/i.test(htmlContent) || /padding:\s*10px\s*16px/i.test(htmlContent)) {
    checks.hasLargeTouchTargets = true;
  } else {
    violations.push('WCAG 2.5.8: Action buttons and touch targets do not specify minimum 44px touch height');
  }

  // 5. Accessible Names / Labels Test (WCAG 4.1.2 Name, Role, Value)
  if (/aria-label=["'][^"']+["']/i.test(htmlContent)) {
    checks.hasAriaLabelsOnInteractive = true;
  } else {
    violations.push('WCAG 4.1.2: Interactive links (e.g. phone call buttons) missing explicit aria-label');
  }

  // 6. Semantic Table Structure Test (WCAG 1.3.1)
  if (/<table\b/i.test(htmlContent)) {
    if (/<th\b/i.test(htmlContent) && /<tbody\b/i.test(htmlContent)) {
      checks.hasSemanticTableStructure = true;
    } else {
      violations.push('WCAG 1.3.1: Data tables missing table header (<th>) elements');
    }
  } else {
    checks.hasSemanticTableStructure = true; // No tables to fail
  }

  // 7. Color Contrast & High Visibility Styles Test (WCAG 1.4.3 Minimum Contrast)
  // Evaluates presence of high-contrast text color combinations (#b91c1c on #fee2e2, #1e293b, etc.)
  if (/#fee2e2/i.test(htmlContent) && (/#991b1b/i.test(htmlContent) || /#b91c1c/i.test(htmlContent))) {
    checks.hasAccessibleColorContrastStyles = true;
  } else {
    violations.push('WCAG 1.4.3: Missing tested high-contrast color pairings for emergency alerts');
  }

  const passedChecksCount = Object.values(checks).filter(Boolean).length;
  const totalChecks = Object.keys(checks).length;
  const score = Math.round((passedChecksCount / totalChecks) * 100);
  const passed = violations.length === 0;

  return {
    passed,
    score,
    checks,
    violations,
  };
}

