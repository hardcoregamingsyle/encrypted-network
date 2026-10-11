import { Link, useLocation } from 'react-router-dom';
import Icon from './Icon.jsx';
import { NAV_ITEMS, activeTab } from './navConfig.js';

// The tab bar at the bottom of a phone screen: Chats, Files, Verify, Me.
export default function BottomTabs() {
  const location = useLocation();
  const active = activeTab(location.pathname);
  return (
    <nav className="ui-tabbar" aria-label="Main tabs">
      <ul className="ui-tabbar__list">
        {NAV_ITEMS.map((item) => (
          <li key={item.id} className="ui-tabbar__item">
            <Link to={item.to} className="ui-tabbar__link" aria-current={active === item.id ? 'page' : undefined}>
              <Icon name={item.icon} size={24} />
              <span className="ui-tabbar__label">{item.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export { BottomTabs, BottomTabs as TabBar };
