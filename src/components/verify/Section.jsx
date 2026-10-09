// One clearly separated section of the Verify page: heading, one plain intro sentence, content.
export default function Section({ id, title, intro, children }) {
  return (
    <section className="ui-card verify-section" id={id} aria-labelledby={`${id}-title`}>
      <h2 className="verify-section__title" id={`${id}-title`}>
        {title}
      </h2>
      {intro ? <p className="verify-section__intro">{intro}</p> : null}
      <div className="verify-section__body">{children}</div>
    </section>
  );
}
