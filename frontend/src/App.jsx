import { BrowserRouter, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Lobby from "./pages/Lobby";
import Auction from "./pages/Auction";
import Result from "./pages/Result";
import Auth from "./pages/Auth";
import History from "./pages/History";

function App() {
    return (
        <BrowserRouter>
            <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/auth" element={<Auth />} />
                <Route path="/history" element={<History />} />
                <Route path="/lobby/:roomId" element={<Lobby />} />
                <Route path="/auction/:roomId" element={<Auction />} />
                <Route path="/result" element={<Result />} />
            </Routes>
        </BrowserRouter>
    );
}

export default App;
