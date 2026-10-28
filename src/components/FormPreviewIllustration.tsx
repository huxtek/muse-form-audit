/**
 * A sketch of what a finished audit looks like, for the landing page.
 *
 * The product's whole argument is the annotated screenshot, and a visitor
 * used to see nothing of it until after committing to a scan -- which needs a
 * URL and, for a real scan, API keys. Five paragraphs described the tool
 * instead. One picture of a marked-up form does that job better.
 *
 * Drawn rather than photographed on purpose: it is obviously an
 * illustration, so it cannot be mistaken for a real audit of the visitor's
 * own site, and it needs no asset, no job id and no running backend.
 */
export const FormPreviewIllustration = () => (
  <svg
    viewBox="0 0 528 236"
    className="block w-full h-auto rounded-lg"
    role="img"
    aria-label="Example report: a form screenshot with three fields outlined, two marked as having problems, and a note reading 'No required attribute, so an agent cannot tell it matters'"
  >
    <rect width="528" height="236" rx="8" fill="#f8fafc" />

    {/* Three labelled rows, the middle two flagged. */}
    <rect x="22" y="20" width="92" height="9" rx="4" fill="#cbd5e1" />
    <rect x="22" y="38" width="300" height="30" rx="5" fill="#fee2e2" stroke="#ef4444" strokeWidth="2" />
    <circle cx="326" cy="53" r="10" fill="#ef4444" />
    <text x="326" y="57" fill="#ffffff" fontSize="10" fontWeight="700" textAnchor="middle">
      3
    </text>

    <rect x="22" y="80" width="92" height="9" rx="4" fill="#cbd5e1" />
    <rect x="22" y="98" width="300" height="30" rx="5" fill="#fef3c7" stroke="#f59e0b" strokeWidth="2" />
    <circle cx="326" cy="113" r="10" fill="#f59e0b" />
    <text x="326" y="117" fill="#ffffff" fontSize="10" fontWeight="700" textAnchor="middle">
      1
    </text>

    <rect x="22" y="140" width="92" height="9" rx="4" fill="#cbd5e1" />
    <rect x="22" y="158" width="180" height="30" rx="5" fill="#dbeafe" stroke="#3b82f6" strokeWidth="2" />

    <rect x="22" y="200" width="120" height="26" rx="5" fill="#7c3aed" />

    {/* The finding itself, which is the part worth seeing. */}
    <rect x="336" y="48" width="178" height="74" rx="7" fill="#0f0f17" stroke="#2a2a3a" />
    <circle cx="350" cy="66" r="4" fill="#ef4444" />
    <text x="362" y="70" fill="#e5e7eb" fontSize="10" fontFamily="ui-monospace, monospace">
      phoneNumber
    </text>
    <text x="348" y="90" fill="#9ca3af" fontSize="9">
      No required attribute, so an
    </text>
    <text x="348" y="104" fill="#9ca3af" fontSize="9">
      agent cannot tell it matters.
    </text>
  </svg>
);

export default FormPreviewIllustration;
