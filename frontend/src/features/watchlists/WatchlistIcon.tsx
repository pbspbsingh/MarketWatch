import type { SvgIconComponent } from "@mui/icons-material";
import AccountBalanceIcon from "@mui/icons-material/AccountBalance";
import AgricultureIcon from "@mui/icons-material/Agriculture";
import AnalyticsIcon from "@mui/icons-material/Analytics";
import AssessmentIcon from "@mui/icons-material/Assessment";
import AttachMoneyIcon from "@mui/icons-material/AttachMoney";
import BarChartIcon from "@mui/icons-material/BarChart";
import BiotechIcon from "@mui/icons-material/Biotech";
import BoltIcon from "@mui/icons-material/Bolt";
import BookmarkIcon from "@mui/icons-material/Bookmark";
import BusinessIcon from "@mui/icons-material/Business";
import CandlestickChartIcon from "@mui/icons-material/CandlestickChart";
import ComputerIcon from "@mui/icons-material/Computer";
import DiamondIcon from "@mui/icons-material/Diamond";
import CorporateFareIcon from "@mui/icons-material/CorporateFare";
import CurrencyExchangeIcon from "@mui/icons-material/CurrencyExchange";
import ElectricBoltIcon from "@mui/icons-material/ElectricBolt";
import FactoryIcon from "@mui/icons-material/Factory";
import FlagIcon from "@mui/icons-material/Flag";
import HealthAndSafetyIcon from "@mui/icons-material/HealthAndSafety";
import HomeIcon from "@mui/icons-material/Home";
import InsightsIcon from "@mui/icons-material/Insights";
import LanguageIcon from "@mui/icons-material/Language";
import LightbulbIcon from "@mui/icons-material/Lightbulb";
import MemoryIcon from "@mui/icons-material/Memory";
import MonetizationOnIcon from "@mui/icons-material/MonetizationOn";
import MyLocationIcon from "@mui/icons-material/MyLocation";
import PaymentsIcon from "@mui/icons-material/Payments";
import PieChartIcon from "@mui/icons-material/PieChart";
import PriceChangeIcon from "@mui/icons-material/PriceChange";
import PublicIcon from "@mui/icons-material/Public";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import SavingsIcon from "@mui/icons-material/Savings";
import ScienceIcon from "@mui/icons-material/Science";
import ShoppingCartIcon from "@mui/icons-material/ShoppingCart";
import ShowChartIcon from "@mui/icons-material/ShowChart";
import StarIcon from "@mui/icons-material/Star";
import StoreIcon from "@mui/icons-material/Store";
import TimelineIcon from "@mui/icons-material/Timeline";
import TrendingUpIcon from "@mui/icons-material/TrendingUp";
import OilBarrelIcon from "@mui/icons-material/OilBarrel";

export const watchlistIcons: { key: string; label: string; Icon: SvgIconComponent }[] = [
  { key: "bookmark", label: "Bookmark", Icon: BookmarkIcon },
  { key: "star", label: "Star", Icon: StarIcon },
  { key: "bolt", label: "Bolt", Icon: BoltIcon },
  { key: "rocket", label: "Rocket", Icon: RocketLaunchIcon },
  { key: "diamond", label: "Diamond", Icon: DiamondIcon },
  { key: "flag", label: "Flag", Icon: FlagIcon },
  { key: "target", label: "Target", Icon: MyLocationIcon },
  { key: "trending-up", label: "Trending", Icon: TrendingUpIcon },
  { key: "show-chart", label: "Chart", Icon: ShowChartIcon },
  { key: "insights", label: "Insights", Icon: InsightsIcon },
  { key: "lightbulb", label: "Idea", Icon: LightbulbIcon },
  { key: "business", label: "Business", Icon: BusinessIcon },
  { key: "payments", label: "Payments", Icon: PaymentsIcon },
  { key: "savings", label: "Savings", Icon: SavingsIcon },
  { key: "public", label: "Global", Icon: PublicIcon },
  { key: "language", label: "Language", Icon: LanguageIcon },
  { key: "computer", label: "Computer", Icon: ComputerIcon },
  { key: "memory", label: "Semiconductor", Icon: MemoryIcon },
  { key: "science", label: "Science", Icon: ScienceIcon },
  { key: "biotech", label: "Biotech", Icon: BiotechIcon },
  { key: "health", label: "Health", Icon: HealthAndSafetyIcon },
  { key: "factory", label: "Factory", Icon: FactoryIcon },
  { key: "home", label: "Home", Icon: HomeIcon },
  { key: "shopping-cart", label: "Shopping", Icon: ShoppingCartIcon },
  { key: "candlestick-chart", label: "Candlestick chart", Icon: CandlestickChartIcon },
  { key: "account-balance", label: "Bank", Icon: AccountBalanceIcon },
  { key: "currency-exchange", label: "Currency exchange", Icon: CurrencyExchangeIcon },
  { key: "attach-money", label: "Dollar", Icon: AttachMoneyIcon },
  { key: "pie-chart", label: "Portfolio", Icon: PieChartIcon },
  { key: "bar-chart", label: "Bar chart", Icon: BarChartIcon },
  { key: "analytics", label: "Analytics", Icon: AnalyticsIcon },
  { key: "timeline", label: "Timeline", Icon: TimelineIcon },
  { key: "monetization-on", label: "Investment", Icon: MonetizationOnIcon },
  { key: "price-change", label: "Price change", Icon: PriceChangeIcon },
  { key: "assessment", label: "Assessment", Icon: AssessmentIcon },
  { key: "corporate-fare", label: "Corporation", Icon: CorporateFareIcon },
  { key: "store", label: "Retail", Icon: StoreIcon },
  { key: "oil-barrel", label: "Oil", Icon: OilBarrelIcon },
  { key: "electric-bolt", label: "Energy", Icon: ElectricBoltIcon },
  { key: "agriculture", label: "Agriculture", Icon: AgricultureIcon },
];

const iconsByKey = new Map(watchlistIcons.map((entry) => [entry.key, entry.Icon]));

export function WatchlistIcon({ iconKey, ...props }: { iconKey: string; fontSize?: "inherit" | "small" | "medium" | "large" }) {
  const Icon = iconsByKey.get(iconKey) ?? BookmarkIcon;
  return <Icon {...props} />;
}
